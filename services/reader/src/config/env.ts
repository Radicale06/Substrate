import path from 'path';
import {
    IMAGE_DOWNLOAD_BUDGET_MS_DEFAULT,
    IMAGE_MAX_PER_CRAWL_DEFAULT,
    IMAGE_TOTAL_BYTES_PER_CRAWL_DEFAULT,
} from './constants';

function positiveIntFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Chrome flags tuned for a small Linux container: no sandbox (we are already isolated),
 * no /dev/shm dependency, and a single process to keep memory down.
 *
 * `--single-process` crashes Chrome on Windows and macOS, so override CHROME_ARGS when
 * running the service outside a container.
 */
const DEFAULT_CHROME_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--single-process',
];

function listFromEnv(name: string, fallback: string[]): string[] {
    const raw = process.env[name];
    if (raw === undefined) {
        return fallback;
    }

    return raw.split(/[,\s]+/).filter(Boolean);
}

export const env = {
    port: positiveIntFromEnv('PORT', 3001),

    /** Root directory for locally persisted artifacts. Mounted as a volume in Docker. */
    storageDir: process.env.STORAGE_DIR || '/app/local-storage',

    /** Chrome binary to drive. When unset, puppeteer uses its own bundled download. */
    chromeExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,

    /** Flags passed to Chrome at launch. Set CHROME_ARGS to replace them wholesale. */
    chromeArgs: listFromEnv('CHROME_ARGS', DEFAULT_CHROME_ARGS),

    /**
     * Shared secret. When set, every /crawl call must present it as a bearer token.
     * This service drives a real browser against arbitrary URLs, so it is meant to sit on
     * an internal network — the key is a second line of defence, not the first.
     */
    apiKey: process.env.READER_API_KEY || undefined,

    /**
     * Public base URL for stored-image links, e.g. https://reader.example.com.
     *
     * Markdown gets pasted elsewhere, so a host-relative /instant-images/... link is wrong
     * the moment it leaves the response. Configured rather than taken from the request's
     * Host header, which the caller controls. Unset leaves links relative, as today.
     */
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') || undefined,

    /**
     * Bounds on image downloading. Tunable because "every image on the page" means very
     * different volumes for a news front page than for a documentation article.
     */
    images: {
        maxPerCrawl: positiveIntFromEnv('IMAGE_MAX_PER_CRAWL', IMAGE_MAX_PER_CRAWL_DEFAULT),
        totalBytesPerCrawl: positiveIntFromEnv(
            'IMAGE_TOTAL_BYTES_PER_CRAWL', IMAGE_TOTAL_BYTES_PER_CRAWL_DEFAULT,
        ),
        budgetMs: positiveIntFromEnv('IMAGE_DOWNLOAD_BUDGET_MS', IMAGE_DOWNLOAD_BUDGET_MS_DEFAULT),
    },

    /**
     * Optional Supabase Storage for screenshots. Without it, screenshots are written to
     * the local volume, which the backend serves.
     */
    supabase: {
        url: process.env.SUPABASE_URL || undefined,
        /**
         * Browser-reachable base URL of the same stack. Needed when `url` is an
         * internal Docker address (http://kong:8000), since screenshot links handed to
         * clients must resolve from outside the compose network.
         */
        publicUrl: process.env.SUPABASE_PUBLIC_URL || undefined,
        /** Service-role key. Bypasses RLS, so it must never reach a browser. */
        serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
        /** Storage bucket for screenshots. Created on first use if missing. */
        bucket: process.env.SUPABASE_SCREENSHOT_BUCKET || 'substrate-screenshots',
        /** Separate bucket for downloaded page images; they have their own lifecycle. */
        imageBucket: process.env.SUPABASE_IMAGE_BUCKET || 'substrate-images',
    },
};

/** Whether Supabase Storage is available for screenshots. */
export function isSupabaseConfigured(): boolean {
    return Boolean(env.supabase.url && env.supabase.serviceRoleKey);
}

/**
 * URL path under which saved screenshots are served.
 *
 * Screenshots are written here but served by the backend, which shares the storage
 * volume — so this path must stay identical on both sides.
 */
export const SCREENSHOT_ROUTE = '/instant-screenshots';

/** Directory backing SCREENSHOT_ROUTE. */
export const screenshotDir = path.join(env.storageDir, 'instant-screenshots');

/**
 * URL path under which downloaded page images are served.
 *
 * Written here and served by the backend off the shared volume, exactly like screenshots
 * — so this path must stay identical on both sides.
 */
export const IMAGE_ROUTE = '/instant-images';

/** Directory backing IMAGE_ROUTE. */
export const imageDir = path.join(env.storageDir, 'instant-images');
