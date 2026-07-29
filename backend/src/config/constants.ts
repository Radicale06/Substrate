/**
 * Bound on a single cache query. Comfortably longer than a keyed lookup needs, and short
 * enough that a wedged database cannot outlast the container healthcheck.
 */
export const DATABASE_QUERY_TIMEOUT_MS = 3_000;

/** Upper bound on the X-Timeout header, in seconds. Mirrors the reader service's own cap. */
export const MAX_REQUEST_TIMEOUT_SECONDS = 180;

// --- Reader service ---

/**
 * Default budget for one crawl. Comfortably above the reader's own 30s navigation
 * timeout, so a page that is merely slow is answered rather than abandoned here.
 */
export const READER_TIMEOUT_MS = 60_000;
/**
 * Added on top of a caller-requested wait. A request that asks the page to be watched
 * for N seconds still needs room for markdown conversion after the last snapshot.
 */
export const READER_CLIENT_SLACK_MS = 15_000;
/**
 * Extra budget when the caller asked for images to be downloaded.
 *
 * That work happens after the page has rendered and is bounded separately by the reader,
 * so without this a slow page plus a full image batch could outlast the default budget
 * and be abandoned here while the service was still working normally.
 */
export const READER_IMAGE_DOWNLOAD_SLACK_MS = 60_000;

// --- Model services ---

/** Model inference is slower than a normal HTTP call, especially on CPU. */
export const INFERENCE_TIMEOUT_MS = 120_000;
/**
 * Texts accepted in one /v1/embeddings call. A caller embedding a segmented document
 * batches its chunks at this size; the endpoint does not batch on their behalf, because
 * hiding the cost would not make it smaller.
 */
export const EMBEDDINGS_MAX_INPUTS = 256;
/** Documents accepted in one /v1/rerank call. */
export const RERANK_MAX_DOCUMENTS = 200;

// --- Web search ---

export const SEARCH_DEFAULT_RESULTS = 5;
export const SEARCH_MAX_RESULTS = 20;
/** How long to wait on the search backend itself, before any page is read. */
export const SEARCH_PROVIDER_TIMEOUT_MS = 15_000;
/** Pages read in parallel. Bounded so a search cannot monopolize the reader service. */
export const SEARCH_READ_CONCURRENCY = 3;
/** Per-page budget when reading results; a slow page must not stall the whole search. */
export const SEARCH_PAGE_TIMEOUT_MS = 20_000;
/**
 * Budget for reading ALL results. The per-page timeout alone bounds nothing useful:
 * 20 slow results at 20s each, three at a time, is over two minutes on one connection.
 * Results still unread when this expires keep their provider-supplied summary.
 */
export const SEARCH_TOTAL_READ_BUDGET_MS = 60_000;



// --- Status page ---

/** Per-service probe budget. Short: a status page must answer even when everything is down. */
export const STATUS_PROBE_TIMEOUT_MS = 3_000;
/**
 * How long a status answer is reused. A page that polls should not become a traffic
 * source of its own, and service availability does not change second to second.
 */
export const STATUS_CACHE_MS = 5_000;

// --- Vector store ---

/**
 * Budget for one vector-store call. Generous because building an HNSW index is not a
 * quick operation on a populated collection, and it runs synchronously.
 */
export const VECTORS_TIMEOUT_MS = 120_000;

// --- Segmenter service ---

/**
 * Budget for one chunking call. Generous because tokenizing a large document is seconds
 * of synchronous CPU work, and the semantic strategy additionally waits on the embedding
 * service before it can answer.
 */
export const SEGMENTER_TIMEOUT_MS = 180_000;

