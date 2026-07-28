import { Injectable, Logger } from '@nestjs/common';
import { BrowserService } from '../rendering/browser.service';
import { DomService } from '../rendering/dom.service';
import { ExtendedScrapingOptions, PageSnapshot } from '../rendering/page-snapshot';
import { looksLikePdf, PdfService } from '../rendering/pdf.service';
import { CrawlRequest } from '../crawl/crawl-request.dto';

/** Formats that need a screenshot captured alongside the DOM snapshot. */
const SHOT_FORMATS = ['screenshot', 'pageshot'];

/**
 * Turns a validated crawl request into a stream of snapshots, combining browser
 * capture with any server-side DOM narrowing the caller asked for.
 */
@Injectable()
export class CrawlerService {
    private readonly logger = new Logger(CrawlerService.name);

    constructor(
        private readonly browserService: BrowserService,
        private readonly domService: DomService,
        private readonly pdfService: PdfService,
    ) {
        // The offending request is already aborted, and the page is halted, by the browser's
        // request guards. The heuristics also fire on legitimate resource-heavy pages, so
        // this is recorded rather than used to block the domain for later callers.
        this.browserService.on('abuse', (event: { url: URL; reason: string; sn: number; }) => {
            this.logger.warn(`Abuse heuristic tripped while crawling ${event.url}`, {
                reason: event.reason,
                sn: event.sn,
            });
        });
    }

    /** Maps request-level options onto the browser's scraping options. */
    toScrapingOptions(options: CrawlRequest, targetUrl: URL): ExtendedScrapingOptions {
        // Attributes are preserved, not flattened to name/value. Dropping domain/path
        // turned a cookie scoped to `.example.com` + `/app` into a host-only, path-`/`
        // one — which is a different cookie, and quietly not the one the caller needed to
        // reach the page they were authenticating to. `url` is supplied only as the
        // fallback scope for cookies that carry neither domain nor path, because
        // puppeteer rejects a cookie with no scope at all.
        const cookies = (options.setCookies || [])
            .filter((cookie) => cookie?.name)
            .map((cookie) => {
                const scoped = cookie.domain || cookie.path;

                return {
                    ...cookie,
                    value: cookie.value ?? '',
                    ...(scoped ? {} : { url: targetUrl.toString() }),
                };
            });

        return {
            proxyUrl: options.proxyUrl,
            cookies,
            favorScreenshot: SHOT_FORMATS.includes(options.format),
            targetSelector: options.targetSelector,
            removeSelector: options.removeSelector,
            waitForSelector: options.waitForSelector,
            overrideUserAgent: options.userAgent,
            // An explicit `timeout` also drains the snapshot stream (see CrawlService);
            // `navigationTimeoutMs` caps the fetch without changing when we answer.
            timeoutMs: options.timeout ? options.timeout * 1000 : options.navigationTimeoutMs,
            withIframe: options.withIframe,
            keepImgDataUrl: options.keepImgDataUrl,
            selfHostname: options.selfHostname,
            storeImages: options.withImagesDownload,
        };
    }

    /**
     * Yields snapshots for `targetUrl`. When the caller supplied raw HTML, or asked for
     * selector/iframe handling, each capture is narrowed server-side before being yielded.
     */
    async *scrape(
        targetUrl: URL,
        scrapingOptions: ExtendedScrapingOptions,
        crawlOptions?: CrawlRequest,
    ): AsyncGenerator<PageSnapshot | undefined> {
        if (crawlOptions?.html) {
            const providedSnapshot: PageSnapshot = {
                href: targetUrl.toString(),
                html: crawlOptions.html,
                title: '',
                text: '',
            };
            yield this.domService.narrowSnapshot(providedSnapshot, scrapingOptions);

            return;
        }

        // Chrome shows PDFs in a viewer the page scripts cannot read, so a .pdf link is
        // fetched and parsed directly — which also skips starting a browser page at all.
        if (looksLikePdf(targetUrl)) {
            const pdf = await this.pdfService.extract(targetUrl, scrapingOptions.timeoutMs);
            if (pdf) {
                yield pdf;

                return;
            }
        }

        const needsNarrowing = Boolean(
            scrapingOptions.targetSelector ||
            scrapingOptions.removeSelector ||
            scrapingOptions.withIframe
        );

        for await (const snapshot of this.browserService.scrape(targetUrl, scrapingOptions)) {
            // A PDF served without a .pdf extension only reveals itself from the response
            // content-type; extract it properly rather than return the empty viewer page.
            const isPdfResponse = snapshot?.contentType?.includes('application/pdf') || snapshot?.pdfs?.length;
            if (isPdfResponse && !snapshot?.parsed?.content) {
                const pdf = await this.pdfService.extract(targetUrl, scrapingOptions.timeoutMs);
                if (pdf) {
                    yield pdf;

                    return;
                }
            }

            yield needsNarrowing ? this.domService.narrowSnapshot(snapshot, scrapingOptions) : snapshot;
        }
    }
}
