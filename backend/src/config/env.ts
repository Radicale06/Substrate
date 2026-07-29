import path from 'path';

function positiveIntFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
    port: positiveIntFromEnv('PORT', 3000),

    /**
     * Root directory for locally persisted artifacts. Shared with the reader service,
     * which writes the screenshots this process serves.
     */
    storageDir: process.env.STORAGE_DIR || '/app/local-storage',

    /**
     * The reader service, which owns the browser. Needed by `GET /<url>` and by search's
     * result reading; unset means both report that it is not configured rather than
     * failing obscurely.
     */
    readerUrl: process.env.READER_URL?.replace(/\/$/, '') || undefined,
    /** Shared secret for the reader service, when it is configured to require one. */
    readerApiKey: process.env.READER_API_KEY || undefined,

    /**
     * The hostname this service is reachable at, used to stop it crawling itself.
     *
     * Set it in any deployment that is publicly addressable. Left unset, the check falls
     * back to the request's Host header — which the caller controls, so it catches honest
     * loops but not deliberate ones.
     */
    publicHostname: process.env.PUBLIC_HOSTNAME?.trim().toLowerCase() || undefined,

    /**
     * The segmenter service, which owns token counting and chunking. Needed by
     * /v1/segment.
     */
    segmenterUrl: process.env.SEGMENTER_URL?.replace(/\/$/, '') || undefined,
    /** Shared secret for the segmenter service, when it requires one. */
    segmenterApiKey: process.env.SEGMENTER_API_KEY || undefined,

    /**
     * Web search. Points at a self-hosted SearXNG instance; when unset the /v1/search
     * endpoint reports that it is not configured rather than failing obscurely.
     */
    searxngUrl: process.env.SEARXNG_URL?.replace(/\/$/, '') || undefined,

    /**
     * Model servers. Both optional: unset means /v1/embeddings and /v1/rerank report
     * that they are not configured rather than failing obscurely.
     */
    embeddingsUrl: process.env.EMBEDDINGS_URL?.replace(/\/$/, '') || undefined,
    rerankerUrl: process.env.RERANKER_URL?.replace(/\/$/, '') || undefined,
    /** Shared secret for those services, when they are configured to require one. */
    inferenceApiKey: process.env.INFERENCE_API_KEY || undefined,

    /**
     * Postgres connection for the crawl cache, read by Prisma. Optional: with no
     * DATABASE_URL the service runs exactly as a standalone install, caching disabled.
     */
    databaseUrl: process.env.DATABASE_URL || undefined,

    /** How long a cached crawl stays fresh. */
    cacheTtlSeconds: positiveIntFromEnv('CACHE_TTL_SECONDS', 3600),

    /**
     * Browser origins allowed to call this API, comma-separated. `*` allows any.
     *
     * Empty by default, which disables CORS entirely — the deliberate choice for a
     * service with no authentication: a permissive default would let any page the user
     * happens to visit drive their reader. Compose sets it to the bundled frontend.
     */
    corsOrigins: (process.env.CORS_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
};

/** Whether a database is configured, and therefore whether caching is possible. */
export function isDatabaseConfigured(): boolean {
    return Boolean(env.databaseUrl);
}

/**
 * URL path under which saved screenshots are served.
 *
 * The reader service writes the images and builds these links; this process serves them
 * off the shared volume, so the path must stay identical on both sides.
 */
export const SCREENSHOT_ROUTE = '/instant-screenshots';

/** Directory backing SCREENSHOT_ROUTE. */
export const screenshotDir = path.join(env.storageDir, 'instant-screenshots');

/**
 * URL path under which downloaded page images are served.
 *
 * Same arrangement as screenshots: the reader service writes the files and builds these
 * links, this process serves them off the shared volume — so the path must stay identical
 * on both sides.
 */
export const IMAGE_ROUTE = '/instant-images';

/** Directory backing IMAGE_ROUTE. */
export const imageDir = path.join(env.storageDir, 'instant-images');
