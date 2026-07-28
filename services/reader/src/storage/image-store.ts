import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import {
    IMAGE_MAX_FILES,
    IMAGE_MAX_TOTAL_BYTES,
    IMAGE_PRUNE_INTERVAL_MS,
    IMAGE_TTL_MS,
} from '../config/constants';
import { env, imageDir, IMAGE_ROUTE, isSupabaseConfigured } from '../config/env';
import { getSupabaseClient } from '../common/supabase-client';
import type { ImageType } from '../images/image-type';

interface StoredFile {
    filePath: string;
    modifiedAt: number;
    size: number;
}

/**
 * Persists downloaded page images and returns the URL to reach them by.
 *
 * Deliberately separate from {@link ScreenshotStore} rather than sharing its limits: a
 * crawl produces one screenshot but dozens of images, so a shared prune namespace would
 * evict every screenshot within a handful of image-heavy crawls.
 *
 * Filenames are CONTENT-ADDRESSED, which buys three things at once: the same image
 * repeated in a page's header and footer is stored once, an image pruned yesterday
 * regenerates the identical filename on the next crawl (so a stale markdown link
 * self-heals), and the extension can only come from the sniffed type — never the URL — so
 * path traversal is structurally impossible rather than filtered out.
 */
@Injectable()
export class ImageStore {
    private readonly logger = new Logger(ImageStore.name);
    private lastPruneAt = 0;
    private bucketReady = false;

    /** Writes the image and returns its URL, or null when it could not be stored. */
    async save(bytes: Buffer, type: ImageType): Promise<string | null> {
        const fileName = `${contentAddress(bytes)}.${type.extension}`;

        if (isSupabaseConfigured()) {
            const uploaded = await this.saveToSupabase(fileName, bytes, type);
            if (uploaded) {
                return uploaded;
            }
            this.logger.warn('Falling back to local image storage');
        }

        return this.saveLocally(fileName, bytes);
    }

    private async saveToSupabase(fileName: string, bytes: Buffer, type: ImageType): Promise<string | null> {
        const client = getSupabaseClient();
        if (!client) {
            return null;
        }

        try {
            await this.ensureBucket();
            const bucket = env.supabase.imageBucket;
            const { error } = await client.storage
                .from(bucket)
                .upload(fileName, bytes, { contentType: type.contentType, upsert: false });

            // With content-addressed names a collision means the identical bytes are
            // already there, which is the common case and a success — not a failure to
            // fall back from.
            if (error && !isAlreadyExists(error.message)) {
                this.logger.warn('Failed to upload image to Supabase', { err: error.message });
                return null;
            }

            const { data } = client.storage.from(bucket).getPublicUrl(fileName);

            return data?.publicUrl ? toBrowserReachableUrl(data.publicUrl) : null;
        } catch (err: any) {
            this.logger.warn('Failed to upload image to Supabase', { err: err?.message });
            return null;
        }
    }

    private async ensureBucket() {
        if (this.bucketReady) {
            return;
        }
        const client = getSupabaseClient()!;
        const { error } = await client.storage.createBucket(env.supabase.imageBucket, { public: true });
        if (error && !isAlreadyExists(error.message)) {
            this.logger.warn('Could not create the image bucket', { err: error.message });
        }
        this.bucketReady = true;
    }

    private async saveLocally(fileName: string, bytes: Buffer): Promise<string | null> {
        const filePath = path.join(imageDir, fileName);

        try {
            await fs.promises.mkdir(imageDir, { recursive: true });

            // Already stored by an earlier crawl. Touch it so retention behaves as LRU
            // rather than evicting an image that is still being requested.
            const existing = await fs.promises.stat(filePath).catch(() => null);
            if (existing?.isFile() && existing.size === bytes.byteLength) {
                const now = new Date();
                await fs.promises.utimes(filePath, now, now).catch(() => undefined);
                return `${IMAGE_ROUTE}/${fileName}`;
            }

            // Write-then-rename: two crawls can be storing the same content-addressed
            // name at once, and a half-written file must never become servable.
            const partPath = `${filePath}.${randomUUID()}.part`;
            await fs.promises.writeFile(partPath, bytes);
            await fs.promises.rename(partPath, filePath);
        } catch (err: any) {
            this.logger.warn(`Failed to store image`, { err: err?.message });
            return null;
        }

        this.pruneInBackground();

        return `${IMAGE_ROUTE}/${fileName}`;
    }

    /** Throttled, fire-and-forget: never delays a response for housekeeping. */
    private pruneInBackground() {
        if (Date.now() - this.lastPruneAt < IMAGE_PRUNE_INTERVAL_MS) {
            return;
        }
        this.lastPruneAt = Date.now();
        this.prune().catch((err) => {
            this.logger.warn('Failed to prune stored images', { err: err?.message });
        });
    }

    /** Evicts by age, then by total bytes, then by file count — oldest first each time. */
    private async prune() {
        const names = await fs.promises.readdir(imageDir).catch(() => [] as string[]);
        const stats = await Promise.all(names.map(async (name): Promise<StoredFile | null> => {
            const filePath = path.join(imageDir, name);
            try {
                const stat = await fs.promises.stat(filePath);
                return stat.isFile() ? { filePath, modifiedAt: stat.mtimeMs, size: stat.size } : null;
            } catch (_err) {
                return null; // raced with another prune
            }
        }));

        const files = (stats.filter(Boolean) as StoredFile[]).sort((a, b) => a.modifiedAt - b.modifiedAt);
        const expiredBefore = Date.now() - IMAGE_TTL_MS;
        const doomed = new Set(files.filter((f) => f.modifiedAt < expiredBefore).map((f) => f.filePath));

        // Only what would otherwise survive counts toward the caps below.
        const survivors = files.filter((f) => !doomed.has(f.filePath));

        let liveBytes = survivors.reduce((total, f) => total + f.size, 0);
        for (const file of survivors) {
            if (liveBytes <= IMAGE_MAX_TOTAL_BYTES && survivors.length - doomed.size <= IMAGE_MAX_FILES) {
                break;
            }
            if (doomed.has(file.filePath)) {
                continue;
            }
            doomed.add(file.filePath);
            liveBytes -= file.size;
        }

        for (const filePath of doomed) {
            await fs.promises.unlink(filePath).catch(() => void 0);
        }
        if (doomed.size) {
            this.logger.log(`Pruned ${doomed.size} stored image(s)`);
        }
    }
}

/** Truncated sha256. 128 bits is far beyond collision risk for a media cache. */
function contentAddress(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

function isAlreadyExists(message: string): boolean {
    return /exist|duplicate|409/i.test(message);
}

/**
 * Storage builds public URLs from the configured SUPABASE_URL, which inside Docker is an
 * internal address. Swap in the public base so the link works from a browser.
 */
function toBrowserReachableUrl(publicUrl: string): string {
    const internal = env.supabase.url;
    const external = env.supabase.publicUrl;
    if (!external || !internal || !publicUrl.startsWith(internal)) {
        return publicUrl;
    }

    return external.replace(/\/$/, '') + publicUrl.slice(internal.replace(/\/$/, '').length);
}
