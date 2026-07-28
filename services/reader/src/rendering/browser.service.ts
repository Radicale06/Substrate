import { EventEmitter } from 'events';
import os from 'os';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { defer, delay, marshalError, singleFlight } from '../common/async';
import type { Browser, CookieParam, Page } from 'puppeteer';
import { TimeoutError } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import puppeteerBlockResources from 'puppeteer-extra-plugin-block-resources';
import puppeteerPageProxy from 'puppeteer-extra-plugin-page-proxy';
import tldExtract from 'tld-extract';

import {
    ABUSE_MAX_DISTINCT_DOMAINS,
    ABUSE_MAX_REQUESTS,
    ABUSE_MAX_REQUESTS_BEFORE_RATE_CHECK,
    ABUSE_MAX_REQUESTS_PER_SECOND,
    BROWSER_LAUNCH_TIMEOUT_MS,
    BROWSER_MIN_HEALTHY_LIFETIME_MS,
    BROWSER_RESTART_BASE_DELAY_MS,
    BROWSER_RESTART_MAX_DELAY_MS,
    DEFAULT_NAVIGATION_TIMEOUT_MS,
    PAGE_HEALTH_CHECK_INTERVAL_MS,
    PAGE_MAX_LIFETIME_MS,
    PAGE_RELEASE_GRACE_MS,
    PAGE_VIEWPORT,
    SNAPSHOT_MAX_DOM_DEPTH,
    SNAPSHOT_MAX_DOM_ELEMENTS,
    WARM_PAGE_POOL_SIZE,
} from '../config/constants';
import { env } from '../config/env';
import { SecurityCompromiseError, ServiceCrashedError, UpstreamFailureError } from '../common/errors';
import { isLoopbackOrPrivateHostname } from '../security/ssrf-guard';
import { redactUrl } from '../common/url';
import { harvestImages } from './image-harvester';
import { PAGE_HELPERS_SCRIPT, SNAPSHOT_REPORTER_SCRIPT } from './injected-script';
import { PageSnapshot, ScrapingOptions } from './page-snapshot';

/** Puppeteer rejects cookies without a name; surface that as a clear error. */
function assertUsableCookie(cookie: CookieParam) {
    if (!cookie.name) {
        throw new Error(`Cookie is missing required field: name`);
    }
}

function buildErrorSnapshot(url: string, title: string, text: string, error: string): PageSnapshot {
    return { title, href: url, html: '', text, error };
}

/** True for the host-resolution failures that should degrade rather than crash. */
function isUnreachableHostError(message?: string): boolean {
    return Boolean(message && (message.includes('Invalid TLD') || message.includes('ERR_NAME_NOT_RESOLVED')));
}

/** Whether two URLs share an origin. Unparsable input is never same-origin. */
function isSameOrigin(a?: string, b?: string): boolean {
    if (!a || !b) {
        return false;
    }
    try {
        return new URL(a).origin === new URL(b).origin;
    } catch (_err) {
        return false;
    }
}

puppeteer.use(require('puppeteer-extra-plugin-stealth')());
puppeteer.use(puppeteerBlockResources({
    blockedTypes: new Set(['media']),
    interceptResolutionPriority: 1,
}));
puppeteer.use(puppeteerPageProxy({
    interceptResolutionPriority: 1,
}));

/**
 * Owns the headless Chromium instance and a pool of pre-warmed pages, and turns a URL
 * into a stream of progressively more complete {@link PageSnapshot}s.
 */
@Injectable()
export class BrowserService extends EventEmitter implements OnModuleDestroy {
    private readonly logger = new Logger(BrowserService.name);

    private browser!: Browser;
    private healthCheckTimer?: NodeJS.Timeout;
    /**
     * Resolves once Chrome is up. Chrome is launched on first use rather than at boot so
     * the HTTP server starts immediately; every caller awaits this same promise.
     */
    private launched?: Promise<void>;
    /** Consecutive launches that died almost immediately; drives the restart backoff. */
    private consecutiveCrashes = 0;
    /** Earliest time a relaunch may be attempted, enforced inside init(). */
    private restartNotBefore = 0;
    /** True while launch() is running, so a concurrent relaunch cannot start a second one. */
    private launching = false;
    /** Set by close(); stops a scheduled relaunch resurrecting Chrome during shutdown. */
    private shuttingDown = false;

    /** Monotonic id per page, for correlating log lines. */
    private nextPageSerial = 0;
    private readonly pageSerials = new WeakMap<Page, number>();

    /** Idle pages kept ready so a request does not pay browser-context startup. */
    private warmPages: Page[] = [];
    private readonly pageReapers = new WeakMap<Page, ReturnType<typeof setTimeout>>();
    private readonly livePages = new Set<Page>();
    private lastPageCreatedAt = 0;

    /**
     * Per-crawl hostname the browser must not fetch: this service's own host, so a page
     * cannot bounce a request back into the crawler. Scoped per page rather than globally
     * so one request's Host header cannot affect anyone else's crawl.
     */
    private readonly selfHostnameByPage = new WeakMap<Page, string>();

    constructor() {
        super();
        this.setMaxListeners(2 * Math.floor(os.totalmem() / (256 * 1024 * 1024)) + 1);

        this.on('crippled', () => {
            this.warmPages.length = 0;
            this.livePages.clear();
        });
    }

    /**
     * Coarse browser state, for the health endpoint.
     *
     * Reported, never asserted: Chrome is launched on first use and relaunched on crash,
     * so `idle` is the normal state of a service that has not been asked for a page yet.
     */
    get status(): { state: 'idle' | 'up' | 'down'; livePages: number; warmPages: number; } {
        return {
            state: !this.launched ? 'idle' : (this.browser?.connected ? 'up' : 'down'),
            livePages: this.livePages.size,
            warmPages: this.warmPages.length,
        };
    }

    /**
     * Launches Chrome if it is not already running. A failed launch clears the cached
     * promise so the next request retries rather than inheriting the failure forever.
     */
    private ensureLaunched(): Promise<void> {
        this.launched ??= this.launch().catch((err) => {
            this.launched = undefined;
            throw err;
        });

        return this.launched;
    }

    /**
     * Discards the current browser so the next request launches a fresh one.
     *
     * A launch already under way is left alone. Clearing `launched` unconditionally let a
     * second launch start beside the first — two Chromes, two health-check intervals, and
     * whichever finished last silently owning `this.browser` while the other leaked.
     * A dying browser's `disconnected` handler fires exactly in that window.
     */
    private scheduleRelaunch(delayMs = 0) {
        if (this.shuttingDown) {
            return;
        }
        if (!this.launching) {
            this.launched = undefined;
        }
        setTimeout(() => {
            if (this.shuttingDown) {
                return;
            }
            this.ensureLaunched().catch(() => undefined);
        }, delayMs).unref();
    }

    private async launch() {
        this.launching = true;
        try {
            return await this.doLaunch();
        } finally {
            this.launching = false;
        }
    }

    private async doLaunch() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = undefined;
        }

        // Honour the crash backoff here rather than only in a timer: anything that
        // triggers a launch — an incoming request, the health check — must wait too, or a
        // steady trickle of traffic restores the tight relaunch loop.
        const backoffRemainingMs = this.restartNotBefore - Date.now();
        if (backoffRemainingMs > 0) {
            await delay(backoffRemainingMs);
        }

        if (this.browser) {
            // Drop the restart listener first, exactly as close() does: this is a
            // deliberate replacement, and leaving it attached made the outgoing browser's
            // disconnect look like a crash — counting toward the backoff and scheduling a
            // relaunch that races the one in progress here.
            this.browser.removeAllListeners('disconnected');
            if (this.browser.connected) {
                await this.browser.close().catch(() => undefined);
            } else {
                this.browser.process()?.kill('SIGKILL');
            }
        }

        this.browser = await puppeteer.launch({
            // Undefined lets puppeteer resolve its own bundled download.
            executablePath: env.chromeExecutablePath,
            args: env.chromeArgs,
            timeout: BROWSER_LAUNCH_TIMEOUT_MS,
        }).catch((err: any) => {
            // Rejecting is enough: the caller surfaces it. Emitting 'error' as well would
            // throw out of the EventEmitter and take the process down.
            this.logger.error(`Failed to launch browser: ${err?.message}`);
            return Promise.reject(err);
        });

        const launchedAt = Date.now();
        this.browser.once('disconnected', () => {
            const lifetimeMs = Date.now() - launchedAt;
            this.emit('crippled');

            if (lifetimeMs >= BROWSER_MIN_HEALTHY_LIFETIME_MS) {
                this.consecutiveCrashes = 0;
                this.restartNotBefore = 0;
                this.logger.warn(`Browser disconnected after ${lifetimeMs}ms, restarting`);
                this.scheduleRelaunch();
                return;
            }

            // Died on startup. Back off so an unlaunchable Chrome cannot spin a tight
            // relaunch loop, and say plainly what usually causes it.
            this.consecutiveCrashes++;
            const delayMs = Math.min(
                BROWSER_RESTART_BASE_DELAY_MS * 2 ** (this.consecutiveCrashes - 1),
                BROWSER_RESTART_MAX_DELAY_MS,
            );
            this.restartNotBefore = Date.now() + delayMs;
            this.logger.error(
                `Browser died ${lifetimeMs}ms after launch (crash #${this.consecutiveCrashes}); ` +
                `retrying in ${delayMs}ms. If this repeats, CHROME_ARGS or ` +
                `PUPPETEER_EXECUTABLE_PATH is likely wrong for this platform ` +
                `(--single-process crashes Chrome outside Linux containers).`,
            );
            this.scheduleRelaunch(delayMs);
        });
        this.logger.log(`Browser launched: ${this.browser.process()?.pid}`);

        this.healthCheckTimer = setInterval(() => this.healthCheck(), PAGE_HEALTH_CHECK_INTERVAL_MS);
        this.newPage().then((page) => this.warmPages.push(page)).catch(() => void 0);
    }

    /** Nest calls this on shutdown, which is how Chrome gets closed on SIGTERM. */
    async onModuleDestroy() {
        await this.close();
    }

    /** Stops the health check and tears down Chrome, for a clean process exit. */
    async close() {
        // Set first, and never cleared: a relaunch already scheduled — or a launch still
        // in flight — would otherwise bring Chrome back up after this returned, leaving an
        // orphaned browser holding the process open past SIGTERM.
        this.shuttingDown = true;
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = undefined;
        }
        // Let an in-flight launch finish so its browser is the one we close, rather than
        // closing the previous one and leaking the new.
        await this.launched?.catch(() => undefined);
        this.launched = undefined;
        if (!this.browser) {
            return;
        }
        // Drop the restart listener first, or closing would look like a crash.
        this.browser.removeAllListeners('disconnected');

        // delay() resolves rather than rejects, so a plain .catch() would never see a
        // hung close. Track completion explicitly and force-kill if it stalls.
        let closed = false;
        const settle = () => { closed = true; };
        await Promise.race([
            this.browser.close().then(settle, settle),
            delay(5000),
        ]);
        if (!closed) {
            this.logger.warn('Browser did not close in time, killing it');
            this.browser.process()?.kill('SIGKILL');
        }
    }

    private logPoolStatus() {
        const live = Array.from(this.livePages).map((p) => this.pageSerials.get(p)).sort().join(', ');
        const idle = this.warmPages.map((p) => this.pageSerials.get(p)).sort().join(', ');
        this.logger.log(`Status: ${this.livePages.size} pages alive: ${live}; ${this.warmPages.length} idle pages: ${idle}`);
    }

    /** Tops up the warm pool, and restarts the browser when page creation stops working. */
    @singleFlight()
    async healthCheck() {
        if (Date.now() - this.lastPageCreatedAt <= 10_000) {
            this.logPoolStatus();
            return;
        }

        const healthyPage = await this.newPage().catch((err) => {
            this.logger.warn(`Health check failed`, { err: marshalError(err) });
            return null;
        });

        if (healthyPage) {
            this.warmPages.push(healthyPage);
            if (this.warmPages.length > WARM_PAGE_POOL_SIZE) {
                this.ditchPage(this.warmPages.shift()!);
            }
            this.logPoolStatus();
            return;
        }

        this.logger.warn(`Trying to clean up...`);
        this.browser.process()?.kill('SIGKILL');
        Reflect.deleteProperty(this, 'browser');
        this.emit('crippled');
        this.scheduleRelaunch();
        this.logger.warn(`Browser killed`);
    }

    /** Last-resort registrable-domain guess when tld-extract cannot parse a URL. */
    private registrableDomainFallback(url: string): string {
        try {
            const { hostname } = new URL(url);
            const labels = hostname.split('.');
            return labels.length > 1 ? labels.slice(-2).join('.') : hostname;
        } catch (error: any) {
            this.logger.warn(`Failed to extract domain from URL: ${redactUrl(url)}. Error: ${error.message}`);
            return url;
        }
    }

    async newPage() {
        await this.ensureLaunched();
        const context = await this.browser.createBrowserContext();
        const serial = this.nextPageSerial++;
        const page = await context.newPage();

        await Promise.all([
            page.setBypassCSP(true),
            page.setViewport(PAGE_VIEWPORT),
            page.exposeFunction('reportSnapshot', (snapshot: PageSnapshot) => {
                if (snapshot?.href === 'about:blank') {
                    return;
                }
                // The reporter only runs in the top frame, but the binding is exposed to
                // every frame and the page's own scripts can call it with anything.
                // Taking it on trust let a third-party iframe's content be streamed as
                // the page. Origins, not full URLs: pushState and hash navigation change
                // page.url() and document.location.href independently.
                if (page.isClosed() || !isSameOrigin(snapshot?.href, page.url())) {
                    return;
                }
                page.emit('snapshot', snapshot);
            }),
            page.evaluateOnNewDocument(PAGE_HELPERS_SCRIPT),
            page.setRequestInterception(true),
        ]);

        await page.goto('about:blank', { waitUntil: 'domcontentloaded' });

        this.installRequestGuards(page, serial);
        await page.evaluateOnNewDocument(SNAPSHOT_REPORTER_SCRIPT);

        this.pageSerials.set(page, serial);
        this.logger.log(`Page ${serial} created.`);
        this.lastPageCreatedAt = Date.now();
        this.livePages.add(page);

        return page;
    }

    /**
     * Blocks SSRF attempts and runaway pages at the network layer. Abuse counters are
     * per page, so they never leak between crawls.
     */
    private installRequestGuards(page: Page, serial: number) {
        const domains = new Set<string>();
        let requestCount = 0;
        let firstRequestAt: number | undefined;
        let halted = false;

        page.on('request', (req) => {
            requestCount++;
            if (halted) {
                return req.abort('blockedbyclient', 1000);
            }
            firstRequestAt ??= Date.now();

            const requestUrl = req.url();
            if (!requestUrl.startsWith('http:') && !requestUrl.startsWith('https:') && requestUrl !== 'about:blank') {
                return req.abort('blockedbyclient', 1000);
            }

            try {
                domains.add(tldExtract(requestUrl).domain);
            } catch (_err) {
                domains.add(this.registrableDomainFallback(requestUrl));
            }

            const parsedUrl = new URL(requestUrl);

            if (parsedUrl.hostname.toLowerCase() === this.selfHostnameByPage.get(page)) {
                // A page trying to reach the crawler itself. Abort the request without
                // failing the crawl, as with the loopback guard below.
                this.logger.warn(`Page ${serial}: Blocked self-referential request: ${redactUrl(requestUrl)}`);
                return req.abort('blockedbyclient', 1000);
            }

            if (isLoopbackOrPrivateHostname(parsedUrl.hostname)) {
                // Block the SSRF attempt without escalating to 'abuse': a legitimate public
                // page may embed a private-address subresource, and escalating would fail the
                // whole crawl. Aborting this one request preserves the protection.
                this.logger.warn(`Page ${serial}: Blocked request to loopback/private address: ${redactUrl(requestUrl)}`);
                return req.abort('blockedbyclient', 1000);
            }

            const elapsedSeconds = Math.ceil((Date.now() - firstRequestAt) / 1000);
            const requestsPerSecond = requestCount / elapsedSeconds;

            if (requestCount > ABUSE_MAX_REQUESTS_BEFORE_RATE_CHECK &&
                (requestsPerSecond > ABUSE_MAX_REQUESTS_PER_SECOND || requestCount > ABUSE_MAX_REQUESTS)) {
                page.emit('abuse', { url: requestUrl, page, sn: serial, reason: `DDoS attack suspected: Too many requests` });
                halted = true;
                return req.abort('blockedbyclient', 1000);
            }

            if (domains.size > ABUSE_MAX_DISTINCT_DOMAINS) {
                page.emit('abuse', { url: requestUrl, page, sn: serial, reason: `DDoS attack suspected: Too many domains` });
                halted = true;
                return req.abort('blockedbyclient', 1000);
            }

            const overrides = req.continueRequestOverrides
                ? [req.continueRequestOverrides(), 0] as const
                : [];

            return req.continue(overrides[0], overrides[1]);
        });
    }

    /** Hands out a warm page if one is ready, pre-warming a replacement as the pool drains. */
    async getNextPage() {
        let page: Page | undefined;
        if (this.warmPages.length) {
            page = this.warmPages.shift();
            if (this.warmPages.length <= 1) {
                this.newPage()
                    .then((replacement) => this.warmPages.push(replacement))
                    .catch((err) => {
                        this.logger.warn(`Failed to load new page ahead of time`, { err: marshalError(err) });
                    });
            }
        }
        page ??= await this.newPage();

        const reaper = setTimeout(() => {
            this.logger.warn(`Page exceeded its ${PAGE_MAX_LIFETIME_MS}ms lifetime, ditching page ${this.pageSerials.get(page!)}...`);
            this.ditchPage(page!);
        }, PAGE_MAX_LIFETIME_MS);
        this.pageReapers.set(page, reaper);

        return page;
    }

    async ditchPage(page: Page) {
        const reaper = this.pageReapers.get(page);
        if (reaper) {
            clearTimeout(reaper);
            this.pageReapers.delete(page);
        }
        // Before the isClosed() bail-out: puppeteer marks a page closed whenever its
        // target goes away — a crashed renderer, not only our own close() — and livePages
        // is a strong Set, so returning first pinned the Page object forever.
        this.livePages.delete(page);
        if (page.isClosed() || this.shuttingDown) {
            // On shutdown the browser is already gone, so closing the page would only
            // produce a "Connection closed" protocol error for something Chrome took
            // with it.
            return;
        }
        const serial = this.pageSerials.get(page);
        this.logger.log(`Closing page ${serial}`);

        await Promise.race([
            (async () => {
                const context = page.browserContext();
                await page.close();
                await context.close();
            })(),
            delay(5000),
        ]).catch((err) => {
            this.logger.error(`Failed to destroy page ${serial}`, { err: marshalError(err) });
        });
    }

    /**
     * Navigates to `parsedUrl` and yields snapshots as the page settles: intermediate
     * captures while it is still loading, then a final one once navigation completes.
     */
    async *scrape(parsedUrl: URL, options?: ScrapingOptions): AsyncGenerator<PageSnapshot | undefined> {
        const url = parsedUrl.toString();
        const page = await this.getNextPage();

        // Only when the caller asked for images: no listener, no CDP traffic and no added
        // latency on an ordinary crawl. A PASSIVE observer — see image-harvester.ts for
        // why this must never become a second page.on('request') handler.
        const harvest = options?.storeImages ? harvestImages(page) : undefined;
        const serial = this.pageSerials.get(page);
        this.logger.log(`Page ${serial}: Scraping ${redactUrl(url)}`, {
            waitForSelector: options?.waitForSelector,
            timeoutMs: options?.timeoutMs,
            cookieCount: options?.cookies?.length || 0,
            usesProxy: Boolean(options?.proxyUrl),
        });

        let snapshot: PageSnapshot | undefined;
        let screenshot: Buffer | undefined;
        let pageshot: Buffer | undefined;

        // Applying options can fail (a rejected cookie, a bad proxy). Hand the page back
        // on any failure, or it stays checked out until the 5-minute reaper fires.
        try {
            if (options?.selfHostname) {
                this.selfHostnameByPage.set(page, options.selfHostname.toLowerCase());
            }
            if (options?.proxyUrl) {
                this.logger.log(`Page ${serial}: Using proxy: ${redactUrl(options.proxyUrl)}`);
                await page.useProxy(options.proxyUrl);
            }
            if (options?.cookies?.length) {
                this.logger.log(`Page ${serial}: Setting ${options.cookies.length} cookie(s)`);
                options.cookies.forEach(assertUsableCookie);
                await page.setCookie(...options.cookies);
            }
            if (options?.overrideUserAgent) {
                await page.setUserAgent(options.overrideUserAgent);
            }
        } catch (err: any) {
            this.logger.warn(`Page ${serial}: Failed to apply scraping options`, { err: marshalError(err) });
            await this.ditchPage(page);
            throw err;
        }

        let nextSnapshot = defer();
        const onCrippled = () => nextSnapshot.reject(new ServiceCrashedError('Browser crashed, try again'));
        const armCrippleListener = () => {
            this.once('crippled', onCrippled);
            // A terminal catch is required: this chain is not the one awaited by the
            // loop, so without it a crash or abuse rejection is an unhandled rejection.
            nextSnapshot.promise
                .finally(() => this.off('crippled', onCrippled))
                .catch(() => void 0);
        };
        armCrippleListener();

        let finalized = false;
        const onSnapshot = (incoming: any) => {
            if (snapshot === incoming) {
                return;
            }
            snapshot = incoming;
            // Do not stream pathological DOMs; the final capture is still attempted.
            if (incoming?.maxElemDepth > SNAPSHOT_MAX_DOM_DEPTH || incoming?.elemCount > SNAPSHOT_MAX_DOM_ELEMENTS) {
                return;
            }
            nextSnapshot.resolve(incoming);
            nextSnapshot = defer();
            armCrippleListener();
        };
        page.on('snapshot', onSnapshot);
        page.once('abuse', (event: any) => {
            this.emit('abuse', { ...event, url: parsedUrl });
            nextSnapshot.reject(new SecurityCompromiseError(`Abuse detected: ${event.reason}`));
        });

        const timeout = options?.timeoutMs || DEFAULT_NAVIGATION_TIMEOUT_MS;

        try {
            // Full-page captures are expensive, so only take one when the caller wants an
            // image. The viewport shot is always taken: it doubles as proof the page rendered.
            const wantsFullPage = Boolean(options?.favorScreenshot);
            const captureFinalState = async () => {
                const childFrames = this.snapshotChildFrames(page);
                snapshot = await page.evaluate('giveSnapshot(true)') as PageSnapshot;
                screenshot = await page.screenshot();
                if (wantsFullPage) {
                    pageshot = await page.screenshot({ fullPage: true });
                }
                if (snapshot) {
                    snapshot.childFrames = await childFrames;
                }
            };

            // Held separately from goto's resolved value, which is an HTTPResponse on success.
            let navigationErrorSnapshot: PageSnapshot | undefined;
            let navigationContentType: string | undefined;

            const gotoPromise = page.goto(url, {
                waitUntil: ['load', 'domcontentloaded', 'networkidle0'],
                timeout,
            }).catch((err: any) => {
                // A dead host or a timeout degrades into an error snapshot rather than
                // taking down the whole request.
                if (err instanceof TimeoutError || isUnreachableHostError(err.message)) {
                    this.logger.warn(`Page ${serial}: Browsing of ${redactUrl(url)} failed`, { err: marshalError(err) });
                    navigationErrorSnapshot = buildErrorSnapshot(
                        url,
                        'Error: Unable to access page',
                        `Failed to access the page: ${err.message}`,
                        err.message,
                    );
                    return null;
                }

                this.logger.warn(`Page ${serial}: Browsing of ${redactUrl(url)} failed`, { err: marshalError(err) });
                return Promise.reject(new UpstreamFailureError(`Failed to goto ${url}: ${err}`, err));
            }).then(async (response) => {
                // Kept so the caller can tell a PDF from a web page without a second
                // request; Chrome's PDF viewer is otherwise opaque to the injected script.
                navigationContentType = response?.headers?.()['content-type'];
                try {
                    await captureFinalState();
                } catch (err: any) {
                    this.logger.warn(`Page ${serial}: Failed to finalize ${redactUrl(url)}`, { err: marshalError(err) });
                }

                if (!snapshot?.html && navigationErrorSnapshot) {
                    // Nothing renderable came back; surface why navigation failed.
                    snapshot = navigationErrorSnapshot;
                }
                finalized = true;
                if (snapshot?.html) {
                    this.logger.log(`Page ${serial}: Snapshot of ${redactUrl(url)} done`, { title: snapshot.title });
                }
            });

            // Tracks that the selector wait finished (found, timed out, or errored), so
            // navigation completing on its own cannot end the stream early.
            let selectorSettled = false;
            let waitForPromise: Promise<any> | undefined;
            if (options?.waitForSelector) {
                const startedAt = Date.now();
                const selectors = Array.isArray(options.waitForSelector)
                    ? options.waitForSelector
                    : [options.waitForSelector];

                // Begin once the page has some content, but fall back to goto completion
                // so a page that never reports a snapshot cannot stall us forever.
                waitForPromise = Promise.race([nextSnapshot.promise, gotoPromise]).then(() => {
                    const remaining = timeout - (Date.now() - startedAt);
                    const selectorTimeout = remaining > 100 ? remaining : 100;

                    return Promise.all(selectors.map((s) => page.waitForSelector(s, { timeout: selectorTimeout })))
                        .then(() => captureFinalState());
                }).catch((err) => {
                    this.logger.warn(`Page ${serial}: Failed to wait for selector ${options.waitForSelector}`, { err: marshalError(err) });
                }).finally(() => {
                    selectorSettled = true;
                    finalized = true;
                });
            }

            try {
                let lastHtml = snapshot?.html;
                while (true) {
                    const raceTargets: Promise<any>[] = [nextSnapshot.promise, gotoPromise];
                    if (waitForPromise) {
                        raceTargets.push(waitForPromise);
                    }
                    if (options?.minIntervalMs) {
                        raceTargets.push(delay(options.minIntervalMs));
                    }

                    let raceError: any;
                    await Promise.race(raceTargets).catch((err) => {
                        raceError = isUnreachableHostError(err?.message)
                            ? new UpstreamFailureError(`Invalid domain or TLD for ${url}: ${err.message}`, err)
                            : err;
                    });

                    const selectorDone = !options?.waitForSelector || selectorSettled;
                    if (finalized && !raceError && selectorDone) {
                        if (!snapshot && !screenshot) {
                            throw new UpstreamFailureError(`Could not extract any meaningful content from the page`);
                        }
                        yield { ...snapshot, screenshot, pageshot, harvest, contentType: navigationContentType } as PageSnapshot;
                        break;
                    }

                    if (options?.favorScreenshot && snapshot?.title && snapshot.html !== lastHtml) {
                        screenshot = await page.screenshot();
                        pageshot = await page.screenshot({ fullPage: true });
                        lastHtml = snapshot.html;
                    }
                    if (snapshot || screenshot) {
                        yield { ...snapshot, screenshot, pageshot, harvest, contentType: navigationContentType } as PageSnapshot;
                    }

                    if (raceError) {
                        if (isUnreachableHostError(raceError.message)) {
                            this.logger.warn(`Continuing despite unreachable host: ${raceError.message}`);
                            yield {
                                ...buildErrorSnapshot(url, '', '', 'Invalid domain or TLD'),
                                screenshot,
                                pageshot,
                            } as PageSnapshot;
                            break;
                        }
                        throw raceError;
                    }
                }
            } catch (error: any) {
                if (!isUnreachableHostError(error?.message)) {
                    throw error;
                }
                this.logger.warn(`Unreachable host for ${redactUrl(url)}: ${error.message}`);
                yield {
                    ...buildErrorSnapshot(url, '', '', 'Invalid domain or TLD'),
                    screenshot,
                    pageshot,
                } as PageSnapshot;
            } finally {
                // Detached immediately, not after the navigation settles: no consumer is
                // left to receive a snapshot, and every one that still arrived re-armed
                // another 'crippled' listener on this service.
                page.off('snapshot', onSnapshot);
                // Stop observing, but keep the bytes: formatting runs after this
                // generator returns, and the handle no longer needs the page alive.
                void harvest?.settle();
                nextSnapshot.resolve();

                // Give an in-flight captureFinalState a moment to finish rather than
                // tearing the page out from under it — but only a moment. On the fast
                // path the consumer already has its answer while goto is still waiting
                // for networkidle0, which on an ad-heavy page means holding a browser
                // context open for the rest of the navigation timeout.
                const pending = Promise.allSettled(
                    [gotoPromise, waitForPromise].filter(Boolean) as Promise<any>[],
                );
                void Promise.race([pending, delay(PAGE_RELEASE_GRACE_MS)])
                    .finally(() => this.ditchPage(page));
            }
        } catch (error: any) {
            // Security blocks and browser crashes must reach the controller so it can map
            // them to a real status code. Swallowing them here would answer HTTP 200 with
            // a body that merely reads like an error.
            if (error instanceof SecurityCompromiseError || error instanceof ServiceCrashedError) {
                throw error;
            }
            this.logger.error(`Unhandled error while scraping ${redactUrl(url)}`, { err: marshalError(error) });
            yield buildErrorSnapshot(
                url,
                'Error: Unhandled exception',
                `An unexpected error occurred: ${error.message}`,
                'Unhandled exception',
            );
        }
    }

    private async snapshotChildFrames(page: Page): Promise<PageSnapshot[]> {
        const frames = page.mainFrame().childFrames();
        const snapshots = await Promise.all(frames.map(async (frame) => {
            const frameUrl = frame.url();
            if (!frameUrl || frameUrl === 'about:blank') {
                return undefined;
            }
            try {
                await frame.evaluate(PAGE_HELPERS_SCRIPT);
                return await frame.evaluate(`giveSnapshot()`);
            } catch (err) {
                this.logger.warn(`Failed to snapshot child frame ${frameUrl}`, { err });
                return undefined;
            }
        })) as PageSnapshot[];

        return snapshots.filter(Boolean);
    }
}
