/** Chunk size used when the caller does not specify one, in tokens. */
export const SEGMENT_DEFAULT_MAX_CHUNK_TOKENS = 1000;
export const SEGMENT_MAX_CHUNK_TOKENS = 8192;

/**
 * Tokenizing is CPU-bound and synchronous, so it blocks the event loop for the whole
 * request. ~250k characters costs roughly 3s; anything larger should be split by the
 * caller rather than stalling every other in-flight request.
 *
 * This service exists partly so that stall is confined here rather than freezing the API.
 */
export const SEGMENT_MAX_CONTENT_CHARS = 250_000;

// --- Semantic strategy ---

/**
 * Where `semantic` cuts: adjacent sentences below this cosine similarity start a new
 * chunk. 0.82 keeps a paragraph's worth of one topic together on typical prose without
 * merging genuinely different sections.
 */
export const SEMANTIC_DEFAULT_SIMILARITY = 0.82;

/**
 * Sentences embedded for one semantic segmentation. Beyond this the strategy degrades to
 * `recursive` rather than issuing an unbounded number of model calls for one request.
 */
export const SEMANTIC_MAX_SENTENCES = 400;

/** Model inference is slower than a normal HTTP call, especially on CPU. */
export const EMBEDDINGS_TIMEOUT_MS = 120_000;
