import { Injectable, Logger } from '@nestjs/common';
import { CrawlerService } from '../crawler/crawler.service';
import { BadRequestError, NotFoundError, SecurityCompromiseError, UpstreamFailureError } from '../common/errors';
import { DomService } from '../rendering/dom.service';
import type { FormattedPage, PageSnapshot } from '../rendering/page-snapshot';
import { SnapshotFormatter } from '../rendering/snapshot-formatter';
import { isAllowedProxyUrl, isLoopbackOrPrivateHostname } from '../security/ssrf-guard';
import { isValidHostname, stripCredentials } from '../common/url';
import { CrawlRequest } from './crawl-request.dto';
import type { CrawlResult } from './crawl-result';

/**
 * Runs one crawl, from validated request to formatted page.
 *
 * This is the whole job of the service: everything about how the result is presented —
 * status envelopes, content negotiation, caching, redirects — belongs to the caller.
 */
@Injectable()
export class CrawlService {
    private readonly logger = new Logger(CrawlService.name);

    constructor(
        private readonly crawlerService: CrawlerService,
        private readonly snapshotFormatter: SnapshotFormatter,
        private readonly domService: DomService,
    ) { }

    async crawl(request: CrawlRequest): Promise<CrawlResult> {
        const targetUrl = this.validate(request);
        const safeUrl = stripCredentials(targetUrl);

        const scrapingOptions = this.crawlerService.toScrapingOptions(request, targetUrl);
        this.logger.log(`Crawling ${safeUrl} as ${request.format}`);

        let lastSnapshot: PageSnapshot | undefined;
        for await (const snapshot of this.crawlerService.scrape(targetUrl, scrapingOptions, request)) {
            if (!snapshot) {
                continue;
            }
            lastSnapshot = snapshot;

            // Keep waiting while the page has no usable content yet. A caller-supplied
            // wait — a selector, or an explicit timeout — means "drain the stream", so
            // those requests only answer once the generator is done.
            const hasContent = Boolean(
                (snapshot.parsed?.content && snapshot.title?.trim()) || snapshot.pdfs?.length
            );
            if (request.waitForSelector || !hasContent || request.timeout !== undefined) {
                continue;
            }

            return this.toResult(request, snapshot, targetUrl);
        }

        if (!lastSnapshot) {
            throw new NotFoundError('No content available');
        }

        // A snapshot that only carries an error is a failed fetch, not page content — say
        // so, rather than returning a result that merely reads like an empty page.
        if (lastSnapshot.error && !lastSnapshot.html) {
            throw new UpstreamFailureError(lastSnapshot.text || lastSnapshot.error);
        }

        return this.toResult(request, lastSnapshot, targetUrl);
    }

    /**
     * Rejects a request before any fetch happens. Runs here rather than in the caller
     * because this service is independently reachable, and it is the process that would
     * actually open the connection.
     */
    private validate(request: CrawlRequest): URL {
        let targetUrl: URL;
        try {
            targetUrl = new URL(request.url);
        } catch (_err) {
            throw new BadRequestError('Invalid URL');
        }
        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            throw new BadRequestError('Only http and https URLs can be crawled');
        }
        if (!isValidHostname(targetUrl.hostname)) {
            throw new BadRequestError('Invalid URL or TLD');
        }
        if (isLoopbackOrPrivateHostname(targetUrl.hostname)) {
            throw new SecurityCompromiseError('Crawling loopback or private addresses is not allowed');
        }
        const selfHostname = request.selfHostname?.toLowerCase();
        if (selfHostname && targetUrl.hostname.toLowerCase() === selfHostname) {
            throw new BadRequestError('Refusing to crawl the calling service itself');
        }
        if (request.proxyUrl && !isAllowedProxyUrl(request.proxyUrl)) {
            throw new BadRequestError('Invalid or disallowed proxy URL');
        }
        // Throws BadRequestError, which the caller reports verbatim.
        this.domService.assertValidSelectors(
            request.targetSelector, request.removeSelector, request.waitForSelector,
        );

        return targetUrl;
    }

    private async toResult(
        request: CrawlRequest,
        snapshot: PageSnapshot,
        targetUrl: URL,
    ): Promise<CrawlResult> {
        const formatted = await this.snapshotFormatter.format(request.format, snapshot, {
            // Credential-free: this URL is echoed back as "URL Source".
            nominalUrl: new URL(stripCredentials(targetUrl)),
            withImagesSummary: request.withImagesSummary,
            withLinksSummary: request.withLinksSummary,
            keepImgDataUrl: request.keepImgDataUrl,
            storeImages: request.withImagesDownload,
            harvest: snapshot.harvest as never,
            userAgent: request.userAgent,
            // A caller-supplied proxy must not be bypassed by a direct re-fetch.
            proxied: Boolean(request.proxyUrl),
        });

        return this.serialize(request.format, formatted);
    }

    /**
     * Flattens a FormattedPage for the wire. `rendered` is captured here because
     * `toString()` cannot survive JSON serialization.
     */
    private serialize(format: CrawlRequest['format'], page: FormattedPage): CrawlResult {
        return {
            format,
            title: page.title,
            description: page.description,
            url: page.url,
            publishedTime: page.publishedTime,
            content: page.content,
            html: page.html,
            text: page.text,
            links: page.links,
            images: page.images,
            screenshotUrl: page.screenshotUrl,
            pageshotUrl: page.pageshotUrl,
            imageAssets: page.imageAssets,
            rendered: `${page}`,
        };
    }
}
