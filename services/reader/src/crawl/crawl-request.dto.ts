import type { CookieParam } from 'puppeteer';
import { MAX_REQUEST_TIMEOUT_SECONDS } from '../config/constants';
import { BadRequestError } from '../common/errors';
import type { ResponseFormat } from '../rendering/page-snapshot';

const RESPONSE_FORMATS: readonly string[] = ['default', 'markdown', 'html', 'text', 'screenshot', 'pageshot'];

/**
 * The crawl request as it arrives over HTTP.
 *
 * The backend has already turned headers into these fields, but this service is
 * independently reachable, so every value is re-validated here rather than trusted.
 */
export class CrawlRequest {
    /** Absolute http(s) URL to fetch. Required, including when `html` is supplied: it is
     *  the base for relative links and the URL echoed back to the caller. */
    url!: string;

    /** Pre-fetched HTML to convert instead of visiting the URL. */
    html?: string;

    format: ResponseFormat = 'default';

    withLinksSummary = false;
    withImagesSummary = false;
    keepImgDataUrl = false;
    withIframe = false;
    /** Download the images the page references and rewrite the links to stored copies. */
    withImagesDownload = false;

    targetSelector?: string | string[];
    waitForSelector?: string | string[];
    removeSelector?: string | string[];

    setCookies?: CookieParam[];
    proxyUrl?: string;
    userAgent?: string;

    /** Seconds to keep collecting snapshots before answering. `null` means "drain". */
    timeout?: number | null;

    /**
     * Hard cap on the fetch itself, in milliseconds.
     *
     * Distinct from `timeout` on purpose: that one also means "keep collecting snapshots
     * for the full duration", which a caller who just wants the page as soon as it is
     * readable — search reading its results — does not want.
     */
    navigationTimeoutMs?: number;

    /**
     * The calling backend's own hostname. Pages are prevented from making requests back
     * to it, so a crawled page cannot use this service as a proxy into its caller.
     */
    selfHostname?: string;

    static from(input: any): CrawlRequest {
        if (!input || typeof input !== 'object') {
            throw new BadRequestError('A JSON object body is required');
        }

        const request = new CrawlRequest();

        request.url = requireString(input.url, 'url');
        request.html = optionalString(input.html, 'html');
        request.format = normalizeFormat(input.format);

        for (const key of [
            'withLinksSummary', 'withImagesSummary', 'keepImgDataUrl', 'withIframe', 'withImagesDownload',
        ] as const) {
            if (input[key] !== undefined) {
                request[key] = Boolean(input[key]);
            }
        }
        for (const key of ['targetSelector', 'waitForSelector', 'removeSelector'] as const) {
            request[key] = normalizeSelector(input[key], key);
        }

        request.proxyUrl = optionalString(input.proxyUrl, 'proxyUrl');
        request.userAgent = optionalString(input.userAgent, 'userAgent');
        request.selfHostname = optionalString(input.selfHostname, 'selfHostname');
        request.setCookies = normalizeCookies(input.setCookies);
        request.timeout = normalizeTimeout(input.timeout);
        request.navigationTimeoutMs = normalizePositiveMs(input.navigationTimeoutMs);

        if (request.withIframe) {
            // Child frames keep loading after the main document, so drain the full stream.
            request.timeout ??= null;
        }
        if (request.html && (request.format === 'screenshot' || request.format === 'pageshot')) {
            throw new BadRequestError(`Cannot render a ${request.format} from an inline html body`);
        }

        return request;
    }
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BadRequestError(`"${field}" must be a non-empty string`);
    }

    return value;
}

function optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new BadRequestError(`"${field}" must be a string`);
    }

    return value || undefined;
}

/** Unrecognized formats fall back to `default`, matching the header behaviour. */
function normalizeFormat(value: unknown): ResponseFormat {
    if (value === undefined || value === null) {
        return 'default';
    }
    const requested = String(value).trim().toLowerCase();

    return RESPONSE_FORMATS.includes(requested) ? requested as ResponseFormat : 'default';
}

function normalizeSelector(value: unknown, field: string): string | string[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === 'string') {
        return value || undefined;
    }
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
        return value.length ? value : undefined;
    }

    throw new BadRequestError(`"${field}" must be a string or an array of strings`);
}

/**
 * Cookies arrive already parsed. Anything without a name is dropped rather than
 * rejected: a malformed Set-Cookie in a long list should not fail the whole crawl.
 */
function normalizeCookies(value: unknown): CookieParam[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const cookies = value.filter(
        (cookie): cookie is CookieParam => Boolean(cookie) && typeof (cookie as any).name === 'string',
    );

    return cookies.length ? cookies : undefined;
}

function normalizePositiveMs(value: unknown): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) {
        throw new BadRequestError('"navigationTimeoutMs" must be a positive number of milliseconds');
    }

    return Math.min(Math.round(ms), MAX_REQUEST_TIMEOUT_SECONDS * 1000);
}

function normalizeTimeout(value: unknown): number | null | undefined {
    if (value === undefined || value === null) {
        return value as null | undefined;
    }
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new BadRequestError('"timeout" must be a positive number of seconds');
    }

    return Math.min(Math.round(seconds), MAX_REQUEST_TIMEOUT_SECONDS);
}
