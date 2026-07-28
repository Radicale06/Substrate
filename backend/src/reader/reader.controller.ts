import { All, Controller, Logger, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CrawlCacheService } from '../cache/crawl-cache.service';
import { CrawlOptions, CrawlOptionsFromHeaders, type ResponseFormat } from './dto/crawl-options.dto';
import { ReaderClient, type ReaderCrawlRequest, type ReaderCrawlResult } from './reader.client';
import { env } from '../config/env';
import { isValidHostname, stripCredentials, toAbsoluteUrl } from '../common/url';
import { sendJson, sendJsonError, sendText, wantsJson } from '../common/http-response';

const USAGE = `Reader — converts any URL into LLM-friendly text.

Usage:
  GET /<url>

Response format is selected with the X-Respond-With header:
  markdown    raw markdown, bypassing Readability
  html        documentElement.outerHTML
  text        body.innerText
  screenshot  viewport PNG (redirects to the saved image)
  pageshot    full-page PNG (redirects to the saved image)

Omit the header to get the default envelope: title, source URL and extracted markdown.

Example:
  curl -H "X-Respond-With: markdown" 'http://127.0.0.1:3000/https://example.com'
`;

/**
 * The `GET /<url>` endpoint.
 *
 * The crawl itself happens in the reader service; what is left here is the public
 * contract — header parsing, caching, content negotiation and the shot redirect.
 *
 * Registered LAST in AppModule: its catch-all route treats any unmatched path as a URL
 * to fetch, so every other route must be declared before it.
 */
@Controller()
export class ReaderController {
    private readonly logger = new Logger(ReaderController.name);

    constructor(
        private readonly readerClient: ReaderClient,
        private readonly crawlCache: CrawlCacheService,
    ) { }

    // '{*splat}' and not '*splat': the braces make the wildcard optional so this also
    // matches '/', which serves the usage page. Registered last via AppModule import order.
    @All('{*splat}')
    async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
        // originalUrl, not req.url: it survives a global prefix and keeps the query
        // string, which belongs to the target URL. Never @Param('splat') — that arrives
        // URL-decoded and split, so %2F would silently become a real path separator.
        const pathTarget = req.originalUrl.slice(1);

        if (pathTarget === 'favicon.ico') {
            return sendText(res, 'Favicon not available', 404);
        }

        let options: CrawlOptions;
        try {
            options = req.method === 'POST'
                ? CrawlOptions.from(req.body ?? {}, req)
                : CrawlOptionsFromHeaders.from({}, req);
        } catch (err: any) {
            this.logger.warn(`Rejected malformed crawl options`, { err: err?.message });
            return sendText(res, `Invalid request options: ${err?.message ?? 'unparseable'}`, 400);
        }

        const rawTarget = pathTarget || options.url;
        if (!rawTarget) {
            return sendText(res, USAGE);
        }

        // Only enough parsing to reject obvious rubbish without a network round-trip.
        // Everything that depends on actually fetching — the SSRF, proxy and selector
        // rules — is enforced by the reader service, which is the process that opens the
        // connection; its status codes are forwarded verbatim.
        const targetUrl = this.parseTargetUrl(rawTarget);
        if (!targetUrl) {
            return sendText(res, 'Invalid URL or TLD', 400);
        }

        const format = options.format;
        const safeUrl = stripCredentials(targetUrl);
        const asJson = wantsJson(req);

        const cacheKey = this.crawlCache.isCacheable(format, options, targetUrl)
            ? this.crawlCache.keyFor({
                url: safeUrl,
                format,
                // The serialized body differs, so JSON and plain text are separate entries.
                json: asJson,
                targetSelector: options.targetSelector,
                removeSelector: options.removeSelector,
                withIframe: options.withIframe,
                withLinksSummary: options.withLinksSummary,
                withImagesSummary: options.withImagesSummary,
                withImagesDownload: options.withImagesDownload,
                keepImgDataUrl: options.keepImgDataUrl,
                userAgent: options.userAgent,
                waitForSelector: options.waitForSelector,
            })
            : undefined;
        if (cacheKey && !options.noCache) {
            const cached = await this.crawlCache.lookup(cacheKey, options.cacheTolerance);
            if (cached !== null) {
                this.logger.log(`Serving ${safeUrl} from cache`);
                res.setHeader('X-Cache', 'HIT');
                if (asJson) {
                    res.type('application/json').send(cached);
                    return;
                }
                return sendText(res, cached);
            }
        }
        if (cacheKey) {
            res.setHeader('X-Cache', 'MISS');
        }

        this.logger.log(`Crawling ${safeUrl} as ${format}`);
        const result = await this.readerClient.crawl(this.toCrawlRequest(options, targetUrl, req));

        return this.respond(res, format, result, asJson, cacheKey, safeUrl);
    }

    /** Parses the request path into a crawlable URL, or null when it is not usable. */
    private parseTargetUrl(rawTarget: string): URL | null {
        try {
            const parsed = new URL(toAbsoluteUrl(rawTarget));
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return null;
            }
            if (!isValidHostname(parsed.hostname)) {
                return null;
            }
            return parsed;
        } catch (_err) {
            return null;
        }
    }

    private toCrawlRequest(options: CrawlOptions, targetUrl: URL, req: Request): ReaderCrawlRequest {
        return {
            url: targetUrl.toString(),
            html: options.html,
            format: options.format,
            withLinksSummary: options.withLinksSummary,
            withImagesSummary: options.withImagesSummary,
            withImagesDownload: options.withImagesDownload,
            keepImgDataUrl: options.keepImgDataUrl,
            withIframe: options.withIframe,
            targetSelector: options.targetSelector,
            waitForSelector: options.waitForSelector,
            removeSelector: options.removeSelector,
            setCookies: options.setCookies,
            proxyUrl: options.proxyUrl,
            userAgent: options.userAgent,
            timeout: options.timeout,
            // Lets the service refuse to crawl us, and stop a crawled page from making
            // requests back to this host. Prefer the configured hostname: req.hostname
            // comes from the Host header (or X-Forwarded-Host, since trust proxy is on),
            // so a caller can otherwise choose what we consider "ourselves".
            selfHostname: env.publicHostname ?? req.hostname,
        };
    }

    private respond(
        res: Response,
        format: ResponseFormat,
        result: ReaderCrawlResult,
        asJson: boolean,
        cacheKey: string | undefined,
        safeUrl: string,
    ): void {
        if (format === 'screenshot' || format === 'pageshot') {
            const shotUrl = format === 'screenshot' ? result.screenshotUrl : result.pageshotUrl;
            if (!shotUrl) {
                return asJson
                    ? sendJsonError(res, `No ${format} was captured for this page`, 502)
                    : sendText(res, `No ${format} was captured for this page`, 502);
            }
            // JSON callers get the URL directly, saving them a redirect round-trip.
            if (asJson) {
                return sendJson(res, { url: result.url, [`${format}Url`]: shotUrl });
            }
            // Host-relative on purpose: reflecting the client's Host header here let a
            // caller choose the redirect target, and it broke behind a reverse proxy that
            // rewrites Host to the internal upstream. The image itself is served by this
            // process, off the storage volume the reader service writes to.
            res.redirect(302, shotUrl);
            return;
        }

        const body = asJson ? JSON.stringify(this.toJsonEnvelope(format, result)) : result.rendered;

        if (!asJson && !body.trim() && (format === 'html' || format === 'text')) {
            // These formats return the page verbatim, so an empty string means the render
            // produced nothing — report it rather than answering 200 with a blank body.
            return sendText(res, `The page produced no ${format} content`, 502);
        }

        if (asJson) {
            res.type('application/json').send(body);
        } else {
            sendText(res, body);
        }

        // Written after responding: the caller should never wait on the cache.
        if (cacheKey) {
            void this.crawlCache.store(cacheKey, safeUrl, format, body);
        }
    }

    /** The `{ code, status, data }` envelope, with only the fields the format produced. */
    private toJsonEnvelope(format: ResponseFormat, page: ReaderCrawlResult) {
        const data: Record<string, unknown> = {
            title: page.title,
            description: page.description,
            url: page.url,
        };

        if (format === 'html') {
            data.html = page.html;
        } else if (format === 'text') {
            data.text = page.text;
        } else {
            data.content = page.content;
            data.publishedTime = page.publishedTime;
        }
        if (page.images) {
            data.images = page.images;
        }
        if (page.links) {
            data.links = page.links;
        }
        if (page.imageAssets?.length) {
            data.imageAssets = page.imageAssets;
        }

        return { code: 200, status: 20000, data };
    }
}
