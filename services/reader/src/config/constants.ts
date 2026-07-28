/** Page navigation timeout when the request does not ask for a specific one. */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

/** Upper bound on a caller-supplied timeout, in seconds. */
export const MAX_REQUEST_TIMEOUT_SECONDS = 180;

// --- Browser page pool ---

/** A handed-out page is force-closed after this long, to bound leaks. */
export const PAGE_MAX_LIFETIME_MS = 300_000;
/**
 * How long a finished crawl waits for its own in-flight navigation before closing the
 * page anyway. The answer has already been returned; this only lets a nearly-complete
 * final capture land, instead of holding a browser context for the rest of a
 * networkidle0 wait that an ad-heavy page may never satisfy.
 */
export const PAGE_RELEASE_GRACE_MS = 2_000;
export const PAGE_HEALTH_CHECK_INTERVAL_MS = 30_000;
/** How many pre-warmed idle pages to keep around. */
export const WARM_PAGE_POOL_SIZE = 3;
export const BROWSER_LAUNCH_TIMEOUT_MS = 10_000;
export const PAGE_VIEWPORT = { width: 1024, height: 1024 };

/**
 * A browser that dies sooner than this after launching is treated as a crash rather than
 * a normal restart, and the relaunch is backed off. Without this, a Chrome that cannot
 * start at all (bad CHROME_ARGS, missing binary) spins in a tight relaunch loop.
 */
export const BROWSER_MIN_HEALTHY_LIFETIME_MS = 5_000;
export const BROWSER_RESTART_BASE_DELAY_MS = 500;
export const BROWSER_RESTART_MAX_DELAY_MS = 30_000;

// --- In-page snapshot streaming ---

export const SNAPSHOT_POLL_INTERVAL_MS = 800;
/**
 * A new snapshot is reported only once body text grows or shrinks by more than
 * 1/Nth of its previous length, so static pages do not stream duplicates.
 */
export const SNAPSHOT_TEXT_CHANGE_DIVISOR = 10;

// --- Pathological DOM protection ---

/** Beyond these bounds, markdown conversion degrades to plain text. */
export const MARKDOWN_MAX_DOM_DEPTH = 256;
export const MARKDOWN_MAX_DOM_ELEMENTS = 70_000;
/** Intermediate snapshots above these bounds are not streamed to the consumer. */
export const SNAPSHOT_MAX_DOM_DEPTH = 256;
export const SNAPSHOT_MAX_DOM_ELEMENTS = 10_000;

/**
 * Readability output is preferred over the full-page conversion when it retains
 * at least this fraction of the content, i.e. when it did not over-trim.
 */
export const READABILITY_MIN_CONTENT_RATIO = 0.3;

// --- Abuse heuristics, applied per page ---

export const ABUSE_MAX_REQUESTS_BEFORE_RATE_CHECK = 1000;
export const ABUSE_MAX_REQUESTS = 2000;
export const ABUSE_MAX_REQUESTS_PER_SECOND = 60;
export const ABUSE_MAX_DISTINCT_DOMAINS = 200;

// --- PDF extraction ---

/** PDFs are fetched directly rather than through the browser, so bound the download. */
export const PDF_MAX_BYTES = 32 * 1024 * 1024;
export const PDF_FETCH_TIMEOUT_MS = 30_000;
/** Redirects are followed manually so each hop can be SSRF-checked. */
export const PDF_MAX_REDIRECTS = 5;
/** Guards against pathological documents; text beyond this is truncated. */
export const PDF_MAX_PAGES = 500;

// --- Saved screenshot retention ---

/** How long a saved screenshot stays on disk. Clients follow the 302 immediately. */
export const SCREENSHOT_TTL_MS = 1000 * 3600;
/** Hard cap on retained screenshots; the oldest are deleted first. */
export const SCREENSHOT_MAX_FILES = 1000;
/** Minimum gap between prune sweeps, so saves do not each scan the directory. */
export const SCREENSHOT_PRUNE_INTERVAL_MS = 60_000;

/** Slow-path warning threshold for DOM/markdown operations. */
export const SLOW_OPERATION_WARN_MS = 1000;

// --- Image download (opt-in, X-With-Images-Download) ---

/**
 * Per image. Deliberately far below PDF_MAX_BYTES: a crawl fetches one PDF but dozens of
 * images, and concurrency x cap is the resident-memory worst case in a container that is
 * also running Chrome.
 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 10_000;
/** Redirects are followed manually so every hop can be SSRF-checked. */
export const IMAGE_MAX_REDIRECTS = 3;
/**
 * Images downloaded for one crawl, counting the whole page rather than just the article.
 * Beyond this the rest keep their original URLs. Override with IMAGE_MAX_PER_CRAWL: an
 * image-heavy page can carry several hundred, so the useful ceiling depends on the sites
 * being crawled and the disk behind STORAGE_DIR.
 */
export const IMAGE_MAX_PER_CRAWL_DEFAULT = 150;
export const IMAGE_TOTAL_BYTES_PER_CRAWL_DEFAULT = 64 * 1024 * 1024;
/**
 * Whole-batch deadline. A default crawl is answered on the first content-bearing snapshot,
 * often within ~2s, so image work must not come to dominate the response time.
 */
export const IMAGE_DOWNLOAD_BUDGET_MS_DEFAULT = 45_000;
export const IMAGE_FETCH_CONCURRENCY = 6;
/**
 * Parallel fetches against one host. Without it, an image-heavy page would have us open
 * forty simultaneous connections to a single origin — a denial of service we would be
 * launching. The browser's own abuse counters do not apply on this path.
 */
export const IMAGE_FETCH_PER_HOST = 2;

// --- Stored image retention (separate from screenshots, deliberately) ---

/**
 * Longer than the backend's crawl-cache TTL on purpose: a screenshot is followed by a 302
 * within milliseconds, but an image URL sits inside markdown that a client stores and an
 * agent may fetch much later. Sharing the screenshot limits would also evict every
 * screenshot within a handful of image-heavy crawls.
 */
export const IMAGE_TTL_MS = 24 * 3600 * 1000;
export const IMAGE_MAX_FILES = 20_000;
/** Byte cap as well as a file count, because images span 2KB to 8MB. */
export const IMAGE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const IMAGE_PRUNE_INTERVAL_MS = 60_000;

// --- Image harvesting (reusing bytes Chrome already downloaded) ---

/** Bodies arrive base64 over the same CDP pipe as page.screenshot(); cap the pipe. */
export const HARVEST_MAX_IMAGES = 100;
export const HARVEST_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Puppeteer's body deferred has no timeout of its own, so impose one. */
export const HARVEST_BODY_TIMEOUT_MS = 5_000;
/** How long formatting waits for bodies still in flight once the page has been ditched. */
export const HARVEST_SETTLE_MS = 1_500;
