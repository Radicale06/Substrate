import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import {
    IMAGE_MAX_BYTES,
    IMAGE_MAX_FILES,
    IMAGE_MAX_TOTAL_BYTES,
    IMAGE_PRUNE_INTERVAL_MS,
    IMAGE_TTL_MS,
} from '../config/constants';
import { env, imageDir, IMAGE_ROUTE, imageStorageMode } from '../config/env';
import { getSupabaseClient } from '../common/supabase-client';
import type { ImageType } from '../images/image-type';

interface StoredFile {
    filePath: string;
    modifiedAt: number;
    size: number;
}

/** MIME types the bucket accepts, mirroring what the magic-byte sniffer can produce. */
const ALLOWED_MIME = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'image/avif', 'image/heic', 'image/bmp', 'image/x-icon',
];

/** A year. Safe because the object name is a hash of its own bytes. */
const IMMUTABLE_CACHE_SECONDS = '31536000';

/**
 * Persists downloaded page images and returns the URL to reach them by.
 *
 * Supabase Storage is the intended home; the local volume is the fallback for a
 * standalone install. Which of the two applies is decided by IMAGE_STORAGE rather than
 * inferred from whether credentials happen to be present.
 *
 * Filenames are CONTENT-ADDRESSED, which buys three things at once: the same image
 * repeated in a page's header and footer is stored once, an image pruned yesterday
 * regenerates the identical name on the next crawl (so a stale markdown link self-heals),
 * and the extension can only come from the sniffed type — never the URL — so path
 * traversal is structurally impossible rather than filtered out.
 */
@Injectable()
export class ImageStore implements OnModuleInit {
    private readonly logger = new Logger(ImageStore.name);
    private lastPruneAt = 0;

    /**
     * Memoized, not a boolean latch. Six image downloads run concurrently, and a plain
     * flag let all six race into bucket creation on the first crawl of a cold install.
     */
    private bucketReady?: Promise<boolean>;

    /** Resolved once at boot so a misconfiguration is a log line, not a surprise later. */
    private mode = imageStorageMode();

    onModuleInit() {
        if (this.mode.problem) {
            this.logger.error(`Image object storage is disabled: ${this.mode.problem}`);
        }
        if (this.mode.useSupabase) {
            this.logger.log(`Images go to the Supabase bucket "${env.supabase.imageBucket}"`);
            // Warm the bucket off the request path.
            void this.ensureBucket();
        } else if (this.mode.allowLocalFallback) {
            this.logger.log('Images go to the local volume');
        } else {
            this.logger.warn(
                'Image downloading is effectively off: object storage is unavailable and '
                + 'IMAGE_STORAGE=supabase forbids the local volume. Images will keep their '
                + 'original URLs.',
            );
        }
    }

    /** Writes the image and returns its URL, or null when it could not be stored. */
    async save(bytes: Buffer, type: ImageType): Promise<string | null> {
        const objectName = objectNameFor(bytes, type.extension);

        if (this.mode.useSupabase) {
            const uploaded = await this.saveToSupabase(objectName, bytes, type);
            if (uploaded) {
                return uploaded;
            }
            this.logger.warn('Image upload to object storage failed');
        }

        /**
         * Checked outside the branch above, which is the whole point of it.
         *
         * IMAGE_STORAGE=supabase with credentials missing resolves to neither Supabase nor
         * a permitted fallback — and that path skipped this check entirely, so the one
         * configuration that exists to forbid local writes was the one that performed them
         * silently. Returning null leaves the original remote URL in the markdown, which
         * resolves, instead of a local link the backend may not be serving.
         */
        if (!this.mode.allowLocalFallback) {
            return null;
        }

        return this.saveLocally(objectName, bytes);
    }

    private async saveToSupabase(objectName: string, bytes: Buffer, type: ImageType): Promise<string | null> {
        const client = getSupabaseClient();
        if (!client || !await this.ensureBucket()) {
            return null;
        }

        try {
            const bucket = env.supabase.imageBucket;
            const { error } = await client.storage
                .from(bucket)
                .upload(objectName, bytes, {
                    contentType: type.contentType,
                    // The object name is a hash of the bytes, so a collision IS the same
                    // image. Overwriting is a semantic no-op, and it removes the need to
                    // classify an "already exists" error at all — which mattered, because
                    // that error's shape is not stable across Storage versions and upload
                    // paths, and a missed match silently fell back to local disk for
                    // every repeat image.
                    upsert: true,
                    cacheControl: IMMUTABLE_CACHE_SECONDS,
                });

            if (error) {
                this.logger.warn('Failed to upload image to Supabase', { err: error.message });
                return null;
            }

            const { data } = client.storage.from(bucket).getPublicUrl(objectName);

            return data?.publicUrl ? toBrowserReachableUrl(data.publicUrl) : null;
        } catch (err: any) {
            this.logger.warn('Failed to upload image to Supabase', { err: err?.message });
            return null;
        }
    }

    /**
     * Creates the bucket once, with the constraints the local path enforced in code.
     *
     * A bucket that exists but is private is treated as a configuration error rather than
     * used: getPublicUrl would happily build links against it that every caller gets a
     * 400 from.
     */
    private ensureBucket(): Promise<boolean> {
        this.bucketReady ??= (async () => {
            const client = getSupabaseClient();
            if (!client) {
                return false;
            }
            const bucket = env.supabase.imageBucket;

            try {
                const existing = await client.storage.getBucket(bucket);
                if (existing.data) {
                    if (!existing.data.public) {
                        this.logger.error(
                            `The bucket "${bucket}" is private, so its public URLs would not resolve. `
                            + 'Make it public, or point SUPABASE_IMAGE_BUCKET at a public bucket.',
                        );
                        return false;
                    }
                    return true;
                }

                const { error } = await client.storage.createBucket(bucket, {
                    public: true,
                    fileSizeLimit: IMAGE_MAX_BYTES,
                    allowedMimeTypes: ALLOWED_MIME,
                });
                if (error) {
                    this.logger.error(`Could not create the image bucket "${bucket}"`, { err: error.message });
                    // Not latched as ready: a later attempt should be able to succeed.
                    this.bucketReady = undefined;
                    return false;
                }

                return true;
            } catch (err: any) {
                this.logger.error('Could not prepare the image bucket', { err: err?.message });
                this.bucketReady = undefined;
                return false;
            }
        })();

        return this.bucketReady;
    }

    private async saveLocally(objectName: string, bytes: Buffer): Promise<string | null> {
        const filePath = path.join(imageDir, objectName);

        try {
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

            // Already stored by an earlier crawl. Touch it so retention behaves as LRU
            // rather than evicting an image that is still being requested.
            const existing = await fs.promises.stat(filePath).catch(() => null);
            if (existing?.isFile() && existing.size === bytes.byteLength) {
                const now = new Date();
                await fs.promises.utimes(filePath, now, now).catch(() => undefined);
                return `${IMAGE_ROUTE}/${objectName}`;
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

        return `${IMAGE_ROUTE}/${objectName}`;
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

    /** Evicts by age, then by total bytes and file count — oldest first each time. */
    private async prune() {
        const files: StoredFile[] = [];

        // Names are sharded two levels deep, so this walks rather than reads one dir.
        const shards = await fs.promises.readdir(imageDir, { withFileTypes: true }).catch(() => []);
        for (const shard of shards) {
            const shardPath = path.join(imageDir, shard.name);
            const entries = shard.isDirectory()
                ? await fs.promises.readdir(shardPath, { withFileTypes: true }).catch(() => [])
                : [];

            for (const inner of entries) {
                const innerPath = path.join(shardPath, inner.name);
                const names = inner.isDirectory()
                    ? await fs.promises.readdir(innerPath).catch(() => [] as string[])
                    : [];

                for (const name of names) {
                    const filePath = path.join(innerPath, name);
                    const stat = await fs.promises.stat(filePath).catch(() => null);
                    if (stat?.isFile()) {
                        files.push({ filePath, modifiedAt: stat.mtimeMs, size: stat.size });
                    }
                }
            }
        }

        files.sort((a, b) => a.modifiedAt - b.modifiedAt);
        const expiredBefore = Date.now() - IMAGE_TTL_MS;
        const doomed = new Set(files.filter((f) => f.modifiedAt < expiredBefore).map((f) => f.filePath));

        // Only what would otherwise survive counts toward the caps below.
        const survivors = files.filter((f) => !doomed.has(f.filePath));
        let liveBytes = survivors.reduce((total, f) => total + f.size, 0);
        let liveCount = survivors.length;

        for (const file of survivors) {
            if (liveBytes <= IMAGE_MAX_TOTAL_BYTES && liveCount <= IMAGE_MAX_FILES) {
                break;
            }
            doomed.add(file.filePath);
            liveBytes -= file.size;
            liveCount--;
        }

        for (const filePath of doomed) {
            await fs.promises.unlink(filePath).catch(() => void 0);
        }
        if (doomed.size) {
            this.logger.log(`Pruned ${doomed.size} stored image(s)`);
        }
    }
}

/**
 * Content address, sharded two levels deep.
 *
 * The shards cost nothing now and are the difference between a workable and an
 * unworkable listing later — neither a filesystem directory nor a Storage prefix listing
 * enjoys a hundred thousand sibling entries. It is not migratable in place, so it is
 * worth doing before anything is stored.
 */
function objectNameFor(bytes: Buffer, extension: string): string {
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);

    return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.${extension}`;
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
