import type { Request } from 'express';
import { parseString as parseSetCookieString, splitCookiesString } from 'set-cookie-parser';
import { MAX_REQUEST_TIMEOUT_SECONDS } from '../../config/constants';
import { BadRequestError } from '../../common/errors';

/** The response shapes a caller can ask for via `X-Respond-With`. */
export type ResponseFormat = 'default' | 'markdown' | 'html' | 'text' | 'screenshot' | 'pageshot';

/**
 * A cookie to set before the page loads.
 *
 * Structurally puppeteer's `CookieParam`, redeclared here so the backend does not depend
 * on puppeteer for a type; the browser lives in the reader service now.
 */
export interface CrawlCookie {
    name: string;
    value?: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    url?: string;
}

const RESPONSE_FORMATS: readonly string[] = ['default', 'markdown', 'html', 'text', 'screenshot', 'pageshot'];

/** Presence of a header enables the flag, except for explicit negative values. */
function parseBooleanHeader(value: string): boolean {
    return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Drops selectors that would match the whole document or arbitrary pseudo-elements,
 * which are expensive and defeat the point of narrowing.
 */
function filterSelector(selector?: string | string[]): string[] | undefined {
    if (!selector) {
        return undefined;
    }
    const candidates = Array.isArray(selector) ? selector : [selector];

    const kept = candidates.filter((entry) => {
        const parts = entry.split(',').map((s) => s.trim());
        return !parts.some((part) => part.startsWith('*') || part.startsWith(':') || part.includes('*:'));
    });

    return kept.length ? kept : undefined;
}

/**
 * Body keys a caller may set, listed explicitly.
 *
 * Not derived from the instance: an optional field with no initializer is not an own
 * property under `useDefineForClassFields: false`, so a `key in instance` test silently
 * dropped every one of them — and, walking the prototype, would have accepted
 * `{"toString": ...}` instead.
 */
const ASSIGNABLE_KEYS = [
    'url',
    'html',
    'respondWith',
    'withLinksSummary',
    'withImagesSummary',
    'withImagesDownload',
    'targetSelector',
    'waitForSelector',
    'removeSelector',
    'keepImgDataUrl',
    'withIframe',
    'noCache',
    'cacheTolerance',
    'setCookies',
    'proxyUrl',
    'userAgent',
    'timeout',
] as const;

export class CrawlOptions {

    url?: string;

    /** Pre-fetched HTML to convert instead of visiting the URL. POST body only. */
    html?: string;

    respondWith: string = 'default';

    withLinksSummary = false;

    withImagesSummary = false;

    /**
     * Download the images the page references and rewrite the links to stored copies.
     * Separate from withImagesSummary because the costs are unrelated: the summary is
     * DOM-only, this one is network and disk.
     */
    withImagesDownload = false;

    targetSelector?: string | string[];

    waitForSelector?: string | string[];

    removeSelector?: string | string[];

    keepImgDataUrl = false;

    withIframe = false;

    /** Bypass the crawl cache for this request. Only meaningful with a database configured. */
    noCache = false;

    /** Accept a cached result up to this many seconds old, overriding the server TTL. */
    cacheTolerance?: number;

    /** Accepts Set-Cookie strings or already-parsed cookie objects. */
    setCookies?: CrawlCookie[];

    proxyUrl?: string;

    userAgent?: string;

    /**
     * Seconds to keep collecting snapshots before responding. Range-checked in `from()`
     * so the caller gets a readable message rather than a dumped validator.
     */
    timeout?: number | null;

    /** The requested response format; unrecognized values fall back to `default`. */
    get format(): ResponseFormat {
        const requested = (this.respondWith || '').trim().toLowerCase();
        return RESPONSE_FORMATS.includes(requested) ? requested as ResponseFormat : 'default';
    }

    /**
     * Builds options from a request body and/or its headers. Unknown body keys are
     * ignored rather than rejected, so a client can send a superset without failing.
     */
    static from(input: any, req?: Request): CrawlOptions {
        const instance = new CrawlOptions();
        for (const key of ASSIGNABLE_KEYS) {
            if (input?.[key] !== undefined) {
                (instance as any)[key] = input[key];
            }
        }

        if (req) {
            CrawlOptions.applyHeaders(instance, req);
        }
        instance.timeout = normalizeTimeout(instance.timeout);
        if (instance.withIframe) {
            // Child frames keep loading after the main document, so drain the full stream.
            instance.timeout ??= null;
        }

        return instance;
    }

    private static applyHeaders(instance: CrawlOptions, req: Request) {
        /** Raw header value. Node joins repeated headers with ", ", which matters below. */
        const getHeader = (name: string): string | undefined => {
            const value = req.headers[name.toLowerCase()];
            return Array.isArray(value) ? value[0] : value;
        };
        /**
         * For headers whose value can never contain a comma. Repeated instances arrive
         * joined as "a, a", so take the first and trim.
         */
        const getScalarHeader = (name: string): string | undefined => {
            const value = getHeader(name);
            return value === undefined ? undefined : value.split(',')[0].trim();
        };

        const requestedFormat = getScalarHeader('x-respond-with') || getScalarHeader('x-return-format');
        if (requestedFormat) {
            instance.respondWith = requestedFormat;
        }

        const booleanHeaders = [
            ['x-with-links-summary', 'withLinksSummary'],
            ['x-with-images-summary', 'withImagesSummary'],
            ['x-with-images-download', 'withImagesDownload'],
            ['x-keep-img-data-url', 'keepImgDataUrl'],
            ['x-with-iframe', 'withIframe'],
            ['x-no-cache', 'noCache'],
        ] as const;
        for (const [header, prop] of booleanHeaders) {
            const raw = getScalarHeader(header);
            if (raw !== undefined) {
                instance[prop] = parseBooleanHeader(raw);
            }
        }

        const rawTimeout = getScalarHeader('x-timeout');
        if (rawTimeout) {
            // Reject rather than silently ignore: a caller who asked to wait should not
            // quietly get the no-wait behaviour because of a typo.
            instance.timeout = parseTimeoutSeconds(rawTimeout, 'X-Timeout');
        }

        const rawTolerance = getScalarHeader('x-cache-tolerance');
        if (rawTolerance) {
            const seconds = Number(rawTolerance);
            if (!Number.isFinite(seconds) || seconds < 0) {
                throw new BadRequestError('X-Cache-Tolerance must be a number of seconds');
            }
            instance.cacheTolerance = Math.round(seconds);
        }

        // Passed through whole: a CSS selector list is natively comma-separated, and
        // splitting it produced invalid fragments that threw inside querySelectorAll.
        instance.removeSelector ??= getHeader('x-remove-selector')?.trim();
        instance.targetSelector ??= getHeader('x-target-selector')?.trim();
        // Filter BEFORE deriving waitForSelector from it: defaulting first handed the
        // rejected selector straight through, so a selector dropped here as unusable came
        // back as a 400 from the reader's validator instead of being ignored.
        instance.targetSelector = filterSelector(instance.targetSelector);
        instance.waitForSelector ??= getHeader('x-wait-for-selector')?.trim() || instance.targetSelector;

        instance.userAgent ??= getHeader('x-user-agent');
        instance.proxyUrl ??= getScalarHeader('x-proxy-url');

        const setCookieHeader = getHeader('x-set-cookie');
        // splitCookiesString keeps `Expires=Wed, 21 Oct ...` intact, unlike a naive split.
        const rawCookies = setCookieHeader
            ? splitCookiesString(setCookieHeader)
            : (instance.setCookies as unknown[]);
        if (Array.isArray(rawCookies) && rawCookies.length) {
            const parsed = rawCookies
                .map((raw) => typeof raw === 'string'
                    ? parseSetCookieString(raw, { decodeValues: false }) as CrawlCookie
                    : raw as CrawlCookie)
                .filter((cookie) => cookie?.name);
            instance.setCookies = parsed.length ? parsed : undefined;
        }
    }
}

function parseTimeoutSeconds(raw: string, label: string): number {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new BadRequestError(`${label} must be a positive number of seconds`);
    }

    return Math.min(Math.round(seconds), MAX_REQUEST_TIMEOUT_SECONDS);
}

/** Applies the same rules to a JSON body value as to the header. */
function normalizeTimeout(value: number | null | undefined): number | null | undefined {
    if (value === undefined || value === null) {
        return value;
    }

    return parseTimeoutSeconds(String(value), 'timeout');
}

/**
 * Options for GET requests, where the URL occupies the path and every setting must
 * therefore come from headers.
 */
export class CrawlOptionsFromHeaders extends CrawlOptions {
    static override from(_input: any, req?: Request): CrawlOptions {
        return CrawlOptions.from({}, req);
    }
}
