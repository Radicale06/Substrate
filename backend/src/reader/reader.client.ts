import { Injectable, Logger } from '@nestjs/common';
import {
    READER_CLIENT_SLACK_MS,
    READER_IMAGE_DOWNLOAD_SLACK_MS,
    READER_TIMEOUT_MS,
} from '../config/constants';
import { env } from '../config/env';
import {
    BadRequestError,
    isDomainError,
    NotFoundError,
    SecurityCompromiseError,
    ServiceCrashedError,
    UpstreamFailureError,
} from '../common/errors';
import type { CrawlCookie } from './dto/crawl-options.dto';

/** The request body accepted by the reader service's `POST /crawl`. */
export interface ReaderCrawlRequest {
    url: string;
    html?: string;
    format?: string;
    withLinksSummary?: boolean;
    withImagesSummary?: boolean;
    withImagesDownload?: boolean;
    keepImgDataUrl?: boolean;
    withIframe?: boolean;
    targetSelector?: string | string[];
    waitForSelector?: string | string[];
    removeSelector?: string | string[];
    setCookies?: CrawlCookie[];
    proxyUrl?: string;
    userAgent?: string;
    timeout?: number | null;
    navigationTimeoutMs?: number;
    selfHostname?: string;
}

/** The reader service's response. Mirrors its `CrawlResult`. */
export interface ReaderCrawlResult {
    format: string;
    title?: string;
    description?: string;
    url?: string;
    publishedTime?: string;
    content?: string;
    html?: string;
    text?: string;
    links?: Array<{ text: string; url: string; }>;
    images?: Record<string, string>;
    screenshotUrl?: string;
    pageshotUrl?: string;
    /** Per-image outcome when images were downloaded. */
    imageAssets?: Array<{
        sourceUrl: string;
        url?: string;
        contentType?: string;
        bytes?: number;
        source?: 'browser' | 'fetch' | 'inline';
        status: 'stored' | 'skipped' | 'failed';
        reason?: string;
    }>;
    /** The service's own plain-text rendering of the page. */
    rendered: string;
}

/**
 * Client for the reader service.
 *
 * The browser lives in its own container so that Chrome's memory and crash behaviour
 * cannot take this process with it; this layer forwards, bounds the wait, and turns the
 * service's status codes back into the domain errors the exception filter already maps.
 */
@Injectable()
export class ReaderClient {
    private readonly logger = new Logger(ReaderClient.name);

    get configured(): boolean {
        return Boolean(env.readerUrl);
    }

    async crawl(request: ReaderCrawlRequest): Promise<ReaderCrawlResult> {
        if (!env.readerUrl) {
            throw new ServiceCrashedError(
                'The reader service is not configured. Set READER_URL, or start the stack '
                + 'with `docker compose up`, which wires it up automatically.',
            );
        }

        const timeoutMs = this.timeoutFor(request);
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), timeoutMs);

        try {
            const response = await fetch(`${env.readerUrl}/crawl`, {
                method: 'POST',
                signal: abort.signal,
                headers: {
                    'content-type': 'application/json',
                    // Selects the service's JSON error bodies over its plain-text ones.
                    accept: 'application/json',
                    ...(env.readerApiKey ? { authorization: `Bearer ${env.readerApiKey}` } : {}),
                },
                body: JSON.stringify(request),
            });

            if (!response.ok) {
                throw this.toDomainError(response.status, await this.readError(response));
            }

            return await response.json() as ReaderCrawlResult;
        } catch (err: any) {
            // The service answered and toDomainError already gave this its status.
            if (isDomainError(err)) {
                throw err;
            }
            if (err?.name === 'AbortError') {
                throw new UpstreamFailureError(`The reader service timed out after ${timeoutMs}ms`);
            }
            this.logger.error(`Reader service at ${env.readerUrl} is unreachable: ${err?.message}`);
            throw new ServiceCrashedError(
                `The reader service at ${env.readerUrl} is not reachable. Start it with `
                + '`docker compose up reader`, or point READER_URL at a running instance.',
            );
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * How long to wait on one crawl.
     *
     * A caller who asked the page to be watched for N seconds has to be given at least
     * that long, plus room for markdown conversion, or this side would give up on a crawl
     * that is proceeding exactly as requested.
     */
    private timeoutFor(request: ReaderCrawlRequest): number {
        // Downloading images is bounded separately by the service and runs after the page
        // has rendered, so it is added on top of whichever budget applies below.
        const images = request.withImagesDownload ? READER_IMAGE_DOWNLOAD_SLACK_MS : 0;

        if (request.timeout === null) {
            // "Drain the stream" — bounded only by the service's own navigation timeout.
            return READER_TIMEOUT_MS + READER_CLIENT_SLACK_MS + images;
        }
        if (request.timeout) {
            return request.timeout * 1000 + READER_CLIENT_SLACK_MS + images;
        }
        if (request.navigationTimeoutMs) {
            return request.navigationTimeoutMs + READER_CLIENT_SLACK_MS + images;
        }

        return READER_TIMEOUT_MS + images;
    }

    /** Keeps the service's status semantics, so a 403 there is still a 403 here. */
    private toDomainError(status: number, message: string): Error {
        switch (status) {
            case 400:
                return new BadRequestError(message);
            case 401:
                return new ServiceCrashedError(
                    'The reader service rejected our API key. READER_API_KEY must match the '
                    + 'key the service was started with.',
                );
            case 403:
                return new SecurityCompromiseError(message);
            case 404:
                return new NotFoundError(message);
            case 503:
                return new ServiceCrashedError(message);
            default:
                return new UpstreamFailureError(message);
        }
    }

    private async readError(response: Response): Promise<string> {
        try {
            const payload = await response.json() as { message?: unknown; };
            return typeof payload?.message === 'string' ? payload.message : JSON.stringify(payload);
        } catch {
            return response.statusText || `Reader service returned ${response.status}`;
        }
    }
}
