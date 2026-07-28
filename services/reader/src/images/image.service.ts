import { Injectable, Logger } from '@nestjs/common';
import {
    IMAGE_FETCH_CONCURRENCY,
    IMAGE_FETCH_PER_HOST,
    IMAGE_MAX_BYTES,
} from '../config/constants';
import { env } from '../config/env';
import { ImageStore } from '../storage/image-store';
import { ImageDownloader } from './image-download';
import { sniffImageType } from './image-type';
import type { HarvestHandle } from '../rendering/image-harvester';
import type { StoredImage } from './stored-image';

export type { StoredImage };

export interface ResolveOptions {
    /** Credential-free page URL, sent as Referer on the fetch path. */
    pageUrl?: string;
    userAgent?: string;
    /** Bodies the browser already downloaded for this crawl, if any. */
    harvest?: HarvestHandle;
    /**
     * Set when the caller routed the crawl through a proxy. The fetch path is then
     * disabled: undici knows nothing about the page-scoped proxy, so re-fetching would
     * leak this service's egress IP for a request the caller asked to be proxied.
     */
    proxied?: boolean;
}

export interface ResolveResult {
    /** Original URL -> the URL to use instead. Only successful stores appear. */
    replacements: Map<string, string>;
    assets: StoredImage[];
}

/**
 * Turns the image URLs a page referenced into stored copies.
 *
 * Bytes come from the cheapest source that has them: an inline `data:` payload needs no
 * network at all, a harvested body was already paid for by the browser, and only what
 * neither covers is fetched. A failure anywhere degrades to keeping the original URL —
 * this must never fail a crawl.
 */
@Injectable()
export class ImageService {
    private readonly logger = new Logger(ImageService.name);

    constructor(
        private readonly downloader: ImageDownloader,
        private readonly store: ImageStore,
    ) { }

    async resolve(urls: string[], options: ResolveOptions = {}): Promise<ResolveResult> {
        const unique = [...new Set(urls)].filter(Boolean);
        const accepted = unique.slice(0, env.images.maxPerCrawl);
        const overflow = unique.slice(env.images.maxPerCrawl);

        const replacements = new Map<string, string>();
        const assets: StoredImage[] = [];
        for (const sourceUrl of overflow) {
            assets.push({ sourceUrl, status: 'skipped', reason: 'budget' });
        }
        if (!accepted.length) {
            this.logOverflow(overflow.length);
            return { replacements, assets };
        }

        // One deadline for the whole batch: response latency must not scale with how many
        // images a page happens to contain.
        const batch = new AbortController();
        const deadline = setTimeout(() => batch.abort(), env.images.budgetMs);

        let totalBytes = 0;
        const inFlightPerHost = new Map<string, number>();
        let next = 0;

        const worker = async () => {
            while (true) {
                const index = next++;
                if (index >= accepted.length) {
                    return;
                }
                const sourceUrl = accepted[index];
                const asset = await this.resolveOne(sourceUrl, options, batch.signal, () => totalBytes, inFlightPerHost);
                if (asset.status === 'stored' && asset.url) {
                    replacements.set(sourceUrl, asset.url);
                    totalBytes += asset.bytes ?? 0;
                }
                assets.push(asset);
            }
        };

        try {
            await Promise.all(
                Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, accepted.length) }, worker),
            );
        } finally {
            clearTimeout(deadline);
        }

        this.logSummary(assets, overflow.length);

        return { replacements, assets };
    }

    private async resolveOne(
        sourceUrl: string,
        options: ResolveOptions,
        signal: AbortSignal,
        spent: () => number,
        inFlightPerHost: Map<string, number>,
    ): Promise<StoredImage> {
        if (spent() >= env.images.totalBytesPerCrawl) {
            return { sourceUrl, status: 'skipped', reason: 'budget' };
        }
        if (signal.aborted) {
            return { sourceUrl, status: 'skipped', reason: 'budget' };
        }

        const fetched = await this.acquire(sourceUrl, options, signal, inFlightPerHost);
        if (!fetched.bytes) {
            return { sourceUrl, status: 'failed', reason: fetched.reason };
        }

        // The Content-Type header and the URL extension are both page-controlled, so the
        // bytes decide. Anything unrecognized — an HTML error page served as 200, an SVG,
        // a video container — is refused rather than stored under a guessed extension.
        const type = sniffImageType(fetched.bytes);
        if (!type) {
            return { sourceUrl, status: 'skipped', reason: 'unsupported-type' };
        }

        const url = await this.store.save(fetched.bytes, type);
        if (!url) {
            return { sourceUrl, status: 'failed', reason: 'store-failed' };
        }

        return {
            sourceUrl,
            url: absolute(url),
            contentType: type.contentType,
            bytes: fetched.bytes.byteLength,
            source: fetched.source,
            status: 'stored',
        };
    }

    /** Cheapest source first: inline payload, then the browser's copy, then the network. */
    private async acquire(
        sourceUrl: string,
        options: ResolveOptions,
        signal: AbortSignal,
        inFlightPerHost: Map<string, number>,
    ): Promise<{ bytes?: Buffer; source?: StoredImage['source']; reason?: string; }> {
        if (sourceUrl.startsWith('data:')) {
            const bytes = decodeDataUrl(sourceUrl);
            return bytes ? { bytes, source: 'inline' } : { reason: 'unsupported-type' };
        }

        const harvested = options.harvest?.take(sourceUrl);
        if (harvested) {
            return { bytes: harvested, source: 'browser' };
        }

        if (options.proxied) {
            // See ResolveOptions.proxied: re-fetching would bypass the caller's proxy.
            return { reason: 'proxied-no-harvest' };
        }

        const host = hostOf(sourceUrl);
        // Forty parallel connections to one origin is a denial of service we would be
        // launching; the browser's abuse counters do not apply on this path.
        while ((inFlightPerHost.get(host) ?? 0) >= IMAGE_FETCH_PER_HOST) {
            if (signal.aborted) {
                return { reason: 'budget' };
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        inFlightPerHost.set(host, (inFlightPerHost.get(host) ?? 0) + 1);

        try {
            const outcome = await this.downloader.download(sourceUrl, {
                referer: options.pageUrl,
                userAgent: options.userAgent,
                signal,
            });

            return outcome.ok ? { bytes: outcome.bytes, source: 'fetch' } : { reason: outcome.reason };
        } finally {
            inFlightPerHost.set(host, (inFlightPerHost.get(host) ?? 1) - 1);
        }
    }

    /** One line per crawl, never one per image. */
    private logSummary(assets: StoredImage[], overflow: number) {
        const stored = assets.filter((a) => a.status === 'stored');
        const fromBrowser = stored.filter((a) => a.source === 'browser').length;
        const inline = stored.filter((a) => a.source === 'inline').length;
        const failed = assets.filter((a) => a.status === 'failed').length;
        const skipped = assets.filter((a) => a.status === 'skipped').length;

        this.logger.log(
            `Stored ${stored.length}/${assets.length} image(s): `
            + `${fromBrowser} from browser, ${inline} inline, `
            + `${stored.length - fromBrowser - inline} fetched`
            + `${failed ? `, ${failed} failed` : ''}`
            + `${skipped ? `, ${skipped} skipped` : ''}`
            + `${overflow ? ` (${overflow} over the per-crawl limit)` : ''}`,
        );
    }

    private logOverflow(count: number) {
        if (count) {
            this.logger.log(`Skipped ${count} image(s) over the per-crawl limit`);
        }
    }
}

/** Makes a stored path absolute when a public base URL is configured. */
function absolute(url: string): string {
    if (!env.publicBaseUrl || /^https?:/i.test(url)) {
        return url;
    }

    return `${env.publicBaseUrl}${url}`;
}

function hostOf(rawUrl: string): string {
    try {
        return new URL(rawUrl).host;
    } catch (_err) {
        return rawUrl;
    }
}

/** Decodes a base64 `data:` image, bounded by the same per-image cap as a download. */
function decodeDataUrl(dataUrl: string): Buffer | null {
    const comma = dataUrl.indexOf(',');
    if (comma < 0 || !/;base64/i.test(dataUrl.slice(0, comma))) {
        return null;
    }
    // 4 base64 chars per 3 bytes; reject before allocating rather than after.
    if ((dataUrl.length - comma) * 3 / 4 > IMAGE_MAX_BYTES) {
        return null;
    }
    try {
        const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
        return bytes.byteLength ? bytes : null;
    } catch (_err) {
        return null;
    }
}
