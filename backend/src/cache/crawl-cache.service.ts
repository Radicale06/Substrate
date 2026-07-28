import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import type { ResponseFormat } from '../reader/dto/crawl-options.dto';

/** Formats whose response body is plain text and therefore cacheable. */
const CACHEABLE_FORMATS: ResponseFormat[] = ['default', 'markdown', 'html', 'text'];

/**
 * Everything that changes the rendered body, and so belongs in the cache key.
 *
 * Anything a caller can influence that reaches the browser has to be here. A field left
 * out does not merely lower the hit rate — it makes one caller's response the answer to a
 * different question, which is how a `X-User-Agent: Googlebot` request ends up serving
 * the cloaked page to everyone else.
 */
export interface CacheKeyParts {
    url: string;
    format: ResponseFormat;
    json?: boolean;
    targetSelector?: string | string[];
    removeSelector?: string | string[];
    withIframe?: boolean;
    withLinksSummary?: boolean;
    withImagesSummary?: boolean;
    /** Changes the links in the body, so it cannot share a key with a plain crawl. */
    withImagesDownload?: boolean;
    keepImgDataUrl?: boolean;
    /** Changes what the site serves. */
    userAgent?: string;
    /** Changes how much of the page has loaded when it is captured. */
    waitForSelector?: string | string[];
}

/** How often expired rows are swept, at most. */
const PURGE_INTERVAL_MS = 5 * 60_000;

/**
 * Crawl results cached in Postgres, so repeat requests for the same URL skip the browser
 * entirely. Inert unless a database is configured, and every failure degrades to a live
 * crawl rather than an error.
 */
@Injectable()
export class CrawlCacheService {
    private readonly logger = new Logger(CrawlCacheService.name);
    private lastPurgeAt = 0;

    constructor(private readonly prisma: PrismaService) { }

    get enabled(): boolean {
        return this.prisma.available;
    }

    /**
     * Screenshots are files rather than bodies, and a request carrying cookies or a proxy
     * is potentially user-specific, so neither is cached.
     */
    isCacheable(
        format: ResponseFormat,
        options: {
            setCookies?: unknown[];
            proxyUrl?: string;
            html?: string;
            waitForSelector?: string | string[];
            timeout?: number | null;
        },
        targetUrl?: URL,
    ): boolean {
        if (!this.enabled || !CACHEABLE_FORMATS.includes(format)) {
            return false;
        }
        // A request that asks to be waited on is answered from the drained snapshot
        // stream, so its body reflects how long the wait ran rather than the URL alone.
        if (options.waitForSelector || options.timeout !== undefined) {
            return false;
        }
        // Credentials in the URL make the response private to whoever supplied them. The
        // cache key is built from the credential-free URL — it has to be, or the secret
        // would be hashed into a shared table — so caching at all would hand the
        // authenticated body to the next anonymous caller for the same URL.
        if (targetUrl?.username || targetUrl?.password) {
            return false;
        }
        // Inline html is supplied by the caller; there is nothing to save by caching it.
        return !options.setCookies?.length && !options.proxyUrl && !options.html;
    }

    keyFor(parts: CacheKeyParts): string {
        const canonical = JSON.stringify([
            parts.url,
            parts.format,
            Boolean(parts.json),
            parts.targetSelector ?? null,
            parts.removeSelector ?? null,
            Boolean(parts.withIframe),
            Boolean(parts.withLinksSummary),
            Boolean(parts.withImagesSummary),
            Boolean(parts.withImagesDownload),
            Boolean(parts.keepImgDataUrl),
            parts.userAgent ?? null,
            parts.waitForSelector ?? null,
        ]);

        return createHash('sha256').update(canonical).digest('hex');
    }

    /**
     * Returns a cached body, or null on a miss. `toleranceSeconds` (from
     * X-Cache-Tolerance) accepts an entry created within that window even if the
     * configured TTL has since passed.
     */
    async lookup(cacheKey: string, toleranceSeconds?: number): Promise<string | null> {
        const db = this.prisma.db;
        if (!db) {
            return null;
        }

        try {
            const entry = await db.crawlCacheEntry.findUnique({ where: { cacheKey } });
            if (!entry) {
                return null;
            }

            const now = Date.now();
            const fresh = toleranceSeconds === undefined
                ? entry.expiresAt.getTime() > now
                : entry.createdAt.getTime() >= now - toleranceSeconds * 1000;

            return fresh ? entry.body : null;
        } catch (err) {
            this.logger.warn(`Cache lookup failed, crawling live: ${(err as Error).message}`);
            return null;
        }
    }

    /** Upserts a crawl result. Never throws: a cache write must not fail the request. */
    async store(cacheKey: string, url: string, format: ResponseFormat, body: string): Promise<void> {
        const db = this.prisma.db;
        if (!db) {
            return;
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + env.cacheTtlSeconds * 1000);
        try {
            await db.crawlCacheEntry.upsert({
                where: { cacheKey },
                create: { cacheKey, url, format, body, createdAt: now, expiresAt },
                update: { url, format, body, createdAt: now, expiresAt },
            });
        } catch (err) {
            this.logger.warn(`Failed to write crawl cache: ${(err as Error).message}`);
        }

        this.purgeInBackground();
    }

    /** Throttled, fire-and-forget sweep of expired rows. */
    private purgeInBackground() {
        if (Date.now() - this.lastPurgeAt < PURGE_INTERVAL_MS) {
            return;
        }
        this.lastPurgeAt = Date.now();

        this.prisma.db?.crawlCacheEntry
            .deleteMany({ where: { expiresAt: { lt: new Date() } } })
            .catch((err) => {
                this.logger.warn(`Failed to purge expired cache rows: ${(err as Error).message}`);
            });
    }
}
