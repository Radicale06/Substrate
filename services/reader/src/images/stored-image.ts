/**
 * What became of one image the page referenced.
 *
 * Its own file so the rendering, crawl and image layers can share the shape without any
 * of them importing another's implementation.
 */
export interface StoredImage {
    /** The absolute URL as it appeared in the page. */
    sourceUrl: string;
    /** Where it can now be fetched. Present only when status is 'stored'. */
    url?: string;
    contentType?: string;
    bytes?: number;
    /** How the bytes were obtained. 'browser' means Chrome had already paid for them. */
    source?: 'browser' | 'fetch' | 'inline';
    status: 'stored' | 'skipped' | 'failed';
    /** Why, when it was not stored. Reported rather than hidden. */
    reason?: string;
}
