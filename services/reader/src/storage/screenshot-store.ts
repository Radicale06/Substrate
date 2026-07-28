import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
    SCREENSHOT_MAX_FILES,
    SCREENSHOT_PRUNE_INTERVAL_MS,
    SCREENSHOT_TTL_MS,
} from '../config/constants';
import { env, isSupabaseConfigured, SCREENSHOT_ROUTE, screenshotDir } from '../config/env';
import { getSupabaseClient } from '../common/supabase-client';

interface StoredFile {
    filePath: string;
    modifiedAt: number;
}

/**
 * Persists page screenshots and returns the URL the client should be redirected to.
 *
 * With Supabase configured, images go to a Storage bucket and outlive the container.
 * Otherwise they are written to the local volume and pruned so an unattended instance
 * cannot fill its disk.
 */
@Injectable()
export class ScreenshotStore {
    private readonly logger = new Logger(ScreenshotStore.name);
    private lastPruneAt = 0;
    private bucketReady = false;

    /**
     * Writes a PNG. Returns an absolute Supabase URL, or a path under the local
     * screenshot route.
     */
    async save(kind: 'screenshot' | 'pageshot', content: Buffer): Promise<string> {
        const fileName = `${kind}-${randomUUID()}.png`;

        if (isSupabaseConfigured()) {
            const uploaded = await this.saveToSupabase(fileName, content);
            if (uploaded) {
                return uploaded;
            }
            this.logger.warn('Falling back to local screenshot storage');
        }

        return this.saveLocally(fileName, content);
    }

    /** Returns the public URL, or null when the upload failed for any reason. */
    private async saveToSupabase(fileName: string, content: Buffer): Promise<string | null> {
        const client = getSupabaseClient();
        if (!client) {
            return null;
        }

        try {
            await this.ensureBucket();
            const { error } = await client.storage
                .from(env.supabase.bucket)
                .upload(fileName, content, { contentType: 'image/png', upsert: false });
            if (error) {
                this.logger.warn('Failed to upload screenshot to Supabase', { err: error.message });
                return null;
            }

            const { data } = client.storage.from(env.supabase.bucket).getPublicUrl(fileName);

            return data?.publicUrl ? this.toBrowserReachableUrl(data.publicUrl) : null;
        } catch (err: any) {
            this.logger.warn('Failed to upload screenshot to Supabase', { err: err?.message });
            return null;
        }
    }

    /**
     * Storage builds public URLs from the configured SUPABASE_URL, which inside Docker is
     * an internal address. Swap in the public base so the link works from a browser.
     */
    private toBrowserReachableUrl(publicUrl: string): string {
        const internal = env.supabase.url;
        const external = env.supabase.publicUrl;
        if (!external || !internal || !publicUrl.startsWith(internal)) {
            return publicUrl;
        }

        return external.replace(/\/$/, '') + publicUrl.slice(internal.replace(/\/$/, '').length);
    }

    /** Creates the bucket on first use; an "already exists" error is the success case. */
    private async ensureBucket() {
        if (this.bucketReady) {
            return;
        }
        const client = getSupabaseClient()!;
        const { error } = await client.storage.createBucket(env.supabase.bucket, { public: true });
        if (error && !/exist/i.test(error.message)) {
            this.logger.warn('Could not create the screenshot bucket', { err: error.message });
        }
        this.bucketReady = true;
    }

    private async saveLocally(fileName: string, content: Buffer): Promise<string> {
        await fs.promises.mkdir(screenshotDir, { recursive: true });
        await fs.promises.writeFile(path.join(screenshotDir, fileName), content);

        this.pruneInBackground();

        return `${SCREENSHOT_ROUTE}/${fileName}`;
    }

    /** Throttled, fire-and-forget: never delays the response for housekeeping. */
    private pruneInBackground() {
        if (Date.now() - this.lastPruneAt < SCREENSHOT_PRUNE_INTERVAL_MS) {
            return;
        }
        this.lastPruneAt = Date.now();
        this.prune().catch((err) => {
            this.logger.warn('Failed to prune saved screenshots', { err: err?.message });
        });
    }

    private async prune() {
        const names = await fs.promises.readdir(screenshotDir).catch(() => [] as string[]);
        const stats = await Promise.all(names.map(async (name): Promise<StoredFile | null> => {
            const filePath = path.join(screenshotDir, name);
            try {
                const stat = await fs.promises.stat(filePath);
                return stat.isFile() ? { filePath, modifiedAt: stat.mtimeMs } : null;
            } catch (_err) {
                return null; // raced with another prune
            }
        }));

        const files = (stats.filter(Boolean) as StoredFile[]).sort((a, b) => a.modifiedAt - b.modifiedAt);
        const expiredBefore = Date.now() - SCREENSHOT_TTL_MS;
        const doomed = new Set(files.filter((f) => f.modifiedAt < expiredBefore).map((f) => f.filePath));

        // Oldest-first over the cap, counting only what would otherwise survive.
        const surplus = files.length - doomed.size - SCREENSHOT_MAX_FILES;
        if (surplus > 0) {
            for (const file of files.filter((f) => !doomed.has(f.filePath)).slice(0, surplus)) {
                doomed.add(file.filePath);
            }
        }

        for (const filePath of doomed) {
            await fs.promises.unlink(filePath).catch(() => void 0);
        }
        if (doomed.size) {
            this.logger.log(`Pruned ${doomed.size} saved screenshot(s)`);
        }
    }
}
