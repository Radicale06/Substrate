import type { CookieParam } from 'puppeteer';
import type { StoredImage } from '../images/stored-image';

export interface ImgBrief {
    src: string;
    loaded?: boolean;
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    alt?: string;
}

/** Shape returned by Mozilla Readability's `parse()`. */
export interface ReadabilityParsed {
    title: string;
    content: string;
    textContent: string;
    length: number;
    excerpt: string;
    byline: string;
    dir: string;
    siteName: string;
    lang: string;
    publishedTime: string;
}

/** One point-in-time capture of a rendered page. */
export interface PageSnapshot {
    title: string;
    href: string;
    /** Set when `document.baseURI` differs from `href`, so relative URLs resolve correctly. */
    rebase?: string;
    html: string;
    text: string;
    parsed?: Partial<ReadabilityParsed> | null;
    screenshot?: Buffer;
    pageshot?: Buffer;
    imgs?: ImgBrief[];
    pdfs?: string[];
    maxElemDepth?: number;
    elemCount?: number;
    /** Content-Type reported by the navigation response, used to detect PDFs. */
    contentType?: string;
    childFrames?: PageSnapshot[];
    error?: string;
    /**
     * Image bytes the browser already downloaded for this page. Internal: it holds
     * Buffers, is never serialized, and is stripped before the result leaves the service.
     */
    harvest?: unknown;
}

/** A snapshot enriched with page-wide link and image inventories. */
export interface ExtendedSnapshot extends PageSnapshot {
    links: { [url: string]: string; };
    imgs: ImgBrief[];
}

/** Options controlling how the browser fetches and renders a page. */
export interface ScrapingOptions {
    proxyUrl?: string;
    cookies?: CookieParam[];
    favorScreenshot?: boolean;
    waitForSelector?: string | string[];
    minIntervalMs?: number;
    overrideUserAgent?: string;
    timeoutMs?: number;
    /** This service's own hostname, which the page must not be able to call back into. */
    selfHostname?: string;
    /** Reuse the image bytes the browser downloads, for the image-storing path. */
    storeImages?: boolean;
}

/** Scraping options plus the DOM-narrowing steps applied after capture. */
export interface ExtendedScrapingOptions extends ScrapingOptions {
    withIframe?: boolean;
    targetSelector?: string | string[];
    removeSelector?: string | string[];
    keepImgDataUrl?: boolean;
}

/** The response shapes a caller can ask for via `X-Respond-With`. */
export type ResponseFormat = 'default' | 'markdown' | 'html' | 'text' | 'screenshot' | 'pageshot';

/** A snapshot rendered into the requested response format. */
export interface FormattedPage {
    title?: string;
    description?: string;
    url?: string;
    content?: string;
    publishedTime?: string;
    html?: string;
    text?: string;
    screenshotUrl?: string;
    pageshotUrl?: string;
    /** Ordered pairs, so links sharing anchor text are not collapsed. */
    links?: Array<{ text: string; url: string; }>;
    images?: { [k: string]: string; };
    /** Per-image outcome when the caller asked for images to be downloaded. */
    imageAssets?: StoredImage[];

    toString: () => string;
}
