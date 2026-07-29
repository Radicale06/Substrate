/**
 * The whole API surface, in one place.
 *
 * Base URL is `/api` by default, which the dev server and the production nginx both
 * proxy to the backend — so the browser only ever makes same-origin requests and CORS
 * stays out of the picture. Point VITE_API_BASE at the backend directly to bypass that,
 * which then requires CORS_ORIGINS to be set on the backend.
 */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '/api';

export type ResponseFormat = 'default' | 'markdown' | 'html' | 'text' | 'screenshot' | 'pageshot';

export interface ReaderOptions {
    format: ResponseFormat;
    targetSelector?: string;
    removeSelector?: string;
    waitForSelector?: string;
    timeout?: string;
    withLinksSummary?: boolean;
    withImagesSummary?: boolean;
    withImagesDownload?: boolean;
    withIframe?: boolean;
    keepImgDataUrl?: boolean;
    noCache?: boolean;
    cacheTolerance?: string;
    userAgent?: string;
    proxyUrl?: string;
    setCookie?: string;
    /** Convert this markup instead of fetching. Sent as a POST body, not a header. */
    html?: string;
}

export interface StoredImage {
    sourceUrl: string;
    url?: string;
    contentType?: string;
    bytes?: number;
    source?: 'browser' | 'fetch' | 'inline';
    status: 'stored' | 'skipped' | 'failed';
    reason?: string;
}

export interface ReaderResult {
    title?: string;
    description?: string;
    url?: string;
    content?: string;
    html?: string;
    text?: string;
    publishedTime?: string;
    links?: Array<{ text: string; url: string; }>;
    images?: Record<string, string>;
    imageAssets?: StoredImage[];
    screenshotUrl?: string;
    pageshotUrl?: string;
    /** Whether the backend served this from its crawl cache. */
    cache?: string;
    /** Milliseconds the whole round-trip took, measured in the browser. */
    elapsedMs: number;
}

export interface SearchHit {
    title: string;
    url: string;
    description?: string;
    content?: string;
}

export const CHUNK_STRATEGIES = [
    'recursive', 'paragraph', 'sentence', 'token', 'markdown', 'semantic',
] as const;

export type ChunkStrategy = typeof CHUNK_STRATEGIES[number];

/** The knobs the segmenter accepts. Sent snake_case, as the API expects. */
export interface ChunkOptions {
    strategy: ChunkStrategy;
    tokenizer: string;
    max_chunk_length: number;
    overlap: number;
    min_chunk_length: number;
    heading_level: number;
    similarity_threshold: number;
}

export interface SegmentResult {
    num_tokens: number;
    tokenizer: string;
    strategy: string;
    /** Set when the requested strategy could not run and a simpler one was used. */
    degraded_from?: string;
    num_chunks?: number;
    chunks?: string[];
    chunk_positions?: Array<[number, number]>;
    chunk_tokens?: number[];
    tokens?: string[];
}

export interface EmbeddingsResult {
    model: string;
    data: Array<{ index: number; embedding: number[]; }>;
    usage?: { total_tokens: number; };
}

export interface RerankResult {
    model: string;
    results: Array<{ index: number; relevance_score: number; document?: { text: string; }; }>;
}

export interface Capability {
    name: string;
    endpoint: string;
    service: string | null;
    state: 'ready' | 'unreachable' | 'not-configured';
    hint?: string;
}

export interface StatusReport {
    capabilities: Capability[];
    cache: { state: string; hint?: string; };
    checkedAt: string;
}

/** An API failure carrying the status, so panels can distinguish 503 from a real error. */
export class ApiError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
        this.name = 'ApiError';
    }

    /** 503 means the capability's service simply is not running. */
    get isUnconfigured(): boolean {
        return this.status === 503;
    }
}

async function readError(response: Response): Promise<string> {
    const body = await response.text().catch(() => '');
    try {
        const parsed = JSON.parse(body);
        return parsed.message ?? parsed.detail ?? body;
    } catch {
        return body || response.statusText || `Request failed with ${response.status}`;
    }
}

/** Turns the reader's option object into the X-* headers the API actually reads. */
function readerHeaders(options: ReaderOptions): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };

    if (options.format !== 'default') {
        headers['x-respond-with'] = options.format;
    }
    const text: Array<[keyof ReaderOptions, string]> = [
        ['targetSelector', 'x-target-selector'],
        ['removeSelector', 'x-remove-selector'],
        ['waitForSelector', 'x-wait-for-selector'],
        ['timeout', 'x-timeout'],
        ['cacheTolerance', 'x-cache-tolerance'],
        ['userAgent', 'x-user-agent'],
        ['proxyUrl', 'x-proxy-url'],
        ['setCookie', 'x-set-cookie'],
    ];
    for (const [key, header] of text) {
        const value = options[key];
        if (typeof value === 'string' && value.trim()) {
            headers[header] = value.trim();
        }
    }
    const flags: Array<[keyof ReaderOptions, string]> = [
        ['withLinksSummary', 'x-with-links-summary'],
        ['withImagesSummary', 'x-with-images-summary'],
        ['withImagesDownload', 'x-with-images-download'],
        ['withIframe', 'x-with-iframe'],
        ['keepImgDataUrl', 'x-keep-img-data-url'],
        ['noCache', 'x-no-cache'],
    ];
    for (const [key, header] of flags) {
        if (options[key]) {
            headers[header] = 'true';
        }
    }

    return headers;
}

export const api = {
    /** Where stored screenshots and images live, for building <img> sources. */
    assetUrl(path: string): string {
        return /^https?:/i.test(path) ? path : `${BASE}${path}`;
    },

    async health(): Promise<{ status: string; cache: string; }> {
        const response = await fetch(`${BASE}/health`);
        if (!response.ok) {
            throw new ApiError(response.status, await readError(response));
        }
        return response.json();
    },

    /**
     * `GET /<url>`. The target URL is the path, so it is appended raw rather than
     * encoded — the backend reads `req.originalUrl` and expects to see it that way.
     */
    async read(target: string, options: ReaderOptions): Promise<ReaderResult> {
        const startedAt = performance.now();

        // Inline markup has to go in a body, so that path is a POST to `/` with the URL
        // as a field. Everything else is the same request with the URL in the path.
        const response = options.html?.trim()
            ? await fetch(`${BASE}/`, {
                method: 'POST',
                headers: { ...readerHeaders(options), 'content-type': 'application/json' },
                body: JSON.stringify({ url: target, html: options.html }),
            })
            : await fetch(`${BASE}/${target}`, { headers: readerHeaders(options) });
        const elapsedMs = Math.round(performance.now() - startedAt);

        if (!response.ok) {
            throw new ApiError(response.status, await readError(response));
        }

        const payload = await response.json();

        return {
            ...(payload.data ?? {}),
            cache: response.headers.get('x-cache') ?? undefined,
            elapsedMs,
        };
    },

    async search(query: string, num: number, read: boolean): Promise<SearchHit[]> {
        const response = await fetch(`${BASE}/v1/search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ q: query, num, readContent: read }),
        });
        if (!response.ok) {
            throw new ApiError(response.status, await readError(response));
        }
        const payload = await response.json();

        // The envelope has carried both shapes; accept either rather than break on one.
        return payload.data?.results ?? payload.data ?? [];
    },

    async status(): Promise<StatusReport> {
        const response = await fetch(`${BASE}/v1/status`);
        if (!response.ok) {
            throw new ApiError(response.status, await readError(response));
        }
        return response.json();
    },

    async segment(body: Record<string, unknown>): Promise<SegmentResult> {
        const response = await fetch(`${BASE}/v1/segment`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new ApiError(response.status, await readError(response));
        }
        return response.json();
    },

    /**
     * Embeddings. Text in, vectors out — nothing else.
     *
     * Splitting text belongs to /v1/segment, and storing the result to /v1/vectors; the
     * caller composes them, which is what makes each one usable on its own.
     */
    async embed(options: {
        input: string[];
        task: string;
        dimensions?: number;
        instruction?: string;
    }): Promise<EmbeddingsResult> {
        const response = await fetch(`${BASE}/v1/embeddings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                input: options.input,
                task: options.task,
                ...(options.dimensions ? { dimensions: options.dimensions } : {}),
                ...(options.instruction?.trim() ? { instruction: options.instruction.trim() } : {}),
            }),
        });
        if (!response.ok) {
            throw new ApiError(response.status, await readError(response));
        }
        return response.json();
    },

    async rerank(
        query: string,
        documents: string[],
        options: { topN?: number; instruction?: string; } = {},
    ): Promise<RerankResult> {
        const response = await fetch(`${BASE}/v1/rerank`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                query,
                documents,
                return_documents: true,
                ...(options.topN ? { top_n: options.topN } : {}),
                ...(options.instruction?.trim() ? { instruction: options.instruction.trim() } : {}),
            }),
        });
        if (!response.ok) {
            throw new ApiError(response.status, await readError(response));
        }
        return response.json();
    },
};

/** Cosine similarity, for showing what an embedding is actually good for. */
export function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}
