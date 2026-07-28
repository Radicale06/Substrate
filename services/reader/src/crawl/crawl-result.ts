import type { ResponseFormat } from '../rendering/page-snapshot';
import type { StoredImage } from '../images/stored-image';

/**
 * What `POST /crawl` answers with.
 *
 * The structured fields let a caller build its own response envelope, while `rendered`
 * carries this service's own plain-text rendering of the same page. Both are returned so
 * that markdown conversion and envelope formatting stay here, next to the DOM code,
 * rather than being reimplemented by every consumer.
 */
export interface CrawlResult {
    /** The format actually produced, after normalization. */
    format: ResponseFormat;

    title?: string;
    description?: string;
    /** The URL the page was requested as, with any credentials stripped. */
    url?: string;
    publishedTime?: string;

    /** Markdown, for the `default` and `markdown` formats. */
    content?: string;
    /** Raw `documentElement.outerHTML`, for the `html` and `pageshot` formats. */
    html?: string;
    /** `body.innerText`, for the `text` format. */
    text?: string;

    /** Ordered pairs, so links sharing anchor text are not collapsed. */
    links?: Array<{ text: string; url: string; }>;
    images?: Record<string, string>;

    /** Where the saved image can be fetched, for the shot formats. */
    screenshotUrl?: string;
    pageshotUrl?: string;

    /**
     * Per-image outcome when the caller asked for images to be downloaded. Failures are
     * reported rather than hidden: an image that could not be stored keeps its original
     * URL in the content, and says here why.
     */
    imageAssets?: StoredImage[];

    /** The plain-text rendering of this page in the requested format. */
    rendered: string;
}
