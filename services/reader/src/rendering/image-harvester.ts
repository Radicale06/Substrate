import { Logger } from '@nestjs/common';
import type { HTTPRequest, Page } from 'puppeteer';
import {
    HARVEST_BODY_TIMEOUT_MS,
    HARVEST_MAX_IMAGES,
    HARVEST_MAX_TOTAL_BYTES,
    HARVEST_SETTLE_MS,
} from '../config/constants';

/** What the formatter is handed: already-materialized bytes, keyed by URL. */
export interface HarvestHandle {
    /** The bytes for a URL, if the browser downloaded it. Each body is handed out once. */
    take(url: string): Buffer | undefined;
    /** Waits briefly for bodies still in flight, then stops accepting new ones. */
    settle(): Promise<void>;
}

const logger = new Logger('ImageHarvester');

/**
 * Reuses the image bytes Chrome already downloaded while rendering the page.
 *
 * Images are not blocked during render — `block-resources` blocks only `media` — so every
 * one of them is fetched and thrown away. Harvesting means an opted-in crawl usually costs
 * no extra bandwidth at all, and it inherits the browser's session: cookies, Referer,
 * signed CDN URLs and hotlink protection all just work, where a bare re-fetch gets a 403
 * or a 429.
 *
 * The security property that makes this the preferred path: a response only exists because
 * `installRequestGuards` already let the request through the protocol, self-host, private
 * address and abuse checks. Harvesting therefore shrinks the set of URLs that ever reach
 * the network-facing downloader down to the ones Chrome never loaded.
 *
 * Deliberately a PASSIVE observer. `page.on('request')` is special-cased by puppeteer into
 * an interception vote, so a second request handler would silently break the cooperative
 * protocol that the SSRF guard, block-resources and page-proxy all depend on.
 * `requestfinished` carries no such wiring — and it is the right event, because the body
 * deferred it resolves has no timeout of its own, so hooking `response` could hang forever
 * on a page that is torn down mid-flight.
 */
export function harvestImages(page: Page): HarvestHandle & { dispose(): void; } {
    const bodies = new Map<string, Buffer>();
    const pending = new Set<Promise<void>>();
    let totalBytes = 0;
    let stopped = false;

    const onRequestFinished = (request: HTTPRequest) => {
        if (stopped || request.resourceType() !== 'image') {
            return;
        }
        if (bodies.size >= HARVEST_MAX_IMAGES || totalBytes >= HARVEST_MAX_TOTAL_BYTES) {
            return;
        }

        const response = request.response();
        if (!response || !response.ok()) {
            return;
        }

        const task = withTimeout(response.buffer(), HARVEST_BODY_TIMEOUT_MS)
            .then((buffer) => {
                if (stopped || !buffer || totalBytes + buffer.byteLength > HARVEST_MAX_TOTAL_BYTES) {
                    return;
                }
                totalBytes += buffer.byteLength;
                // Index the whole redirect chain: the markdown holds the URL as written in
                // the page, which for a redirected image is not response.url().
                for (const url of aliasesOf(request, response.url())) {
                    if (!bodies.has(url)) {
                        bodies.set(url, buffer);
                    }
                }
            })
            // Expected and frequent: bodies evicted from Chrome's buffer, redirect hops
            // that have none, and anything still in flight when the page closes.
            .catch(() => undefined)
            .finally(() => pending.delete(task));

        pending.add(task);
    };

    page.on('requestfinished', onRequestFinished);

    return {
        take(url: string): Buffer | undefined {
            const key = stripFragment(url);
            const found = bodies.get(key);
            if (found) {
                // Handed out once: the caller stores it, and holding every body for the
                // life of the crawl is what the byte cap exists to prevent.
                bodies.delete(key);
            }

            return found;
        },

        async settle() {
            await withTimeout(Promise.allSettled([...pending]), HARVEST_SETTLE_MS).catch(() => undefined);
            stopped = true;
        },

        dispose() {
            stopped = true;
            page.off('requestfinished', onRequestFinished);
            bodies.clear();
            pending.clear();
            totalBytes = 0;
        },
    };
}

/**
 * Every URL this body could be referenced by: the final one plus each redirect hop.
 *
 * CDP strips fragments into a separate field, so they are removed on both sides rather
 * than left to make `sprite.svg#icon` a permanent miss.
 */
function aliasesOf(request: HTTPRequest, finalUrl: string): string[] {
    const urls = [finalUrl, request.url(), ...request.redirectChain().map((hop) => hop.url())];

    return [...new Set(urls.map(stripFragment))];
}

function stripFragment(url: string): string {
    const hash = url.indexOf('#');

    return hash < 0 ? url : url.slice(0, hash);
}

/** Resolves to undefined rather than rejecting, so a slow body never blocks a crawl. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return Promise.race([
        promise,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref()),
    ]);
}

export { logger as harvesterLogger };
