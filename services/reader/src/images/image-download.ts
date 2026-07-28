import { Injectable, Logger } from '@nestjs/common';
import { promises as dns } from 'dns';
import {
    IMAGE_FETCH_TIMEOUT_MS,
    IMAGE_MAX_BYTES,
    IMAGE_MAX_REDIRECTS,
} from '../config/constants';
import { declaredLengthExceeds, readCapped } from '../common/http-download';
import { isLoopbackOrPrivateHostname } from '../security/ssrf-guard';
import { isValidHostname, redactUrl } from '../common/url';

export type DownloadFailure =
    | 'blocked'
    | 'too-large'
    | 'http-error'
    | 'timeout'
    | 'read-failed'
    | 'too-many-redirects';

export type DownloadOutcome =
    | { ok: true; bytes: Buffer; }
    | { ok: false; reason: DownloadFailure; };

/**
 * Fetches one image over the network, for the images the browser did not already have.
 *
 * Every URL here came out of the crawled page, so it is attacker-chosen. That is the
 * difference between this and the harvest path: a harvested body only exists because the
 * browser's own request guards already let the request through, whereas everything below
 * has to re-establish those guarantees from scratch.
 */
@Injectable()
export class ImageDownloader {
    private readonly logger = new Logger(ImageDownloader.name);

    /**
     * `referer` is the credential-free page URL. Cookies are deliberately NOT forwarded:
     * they may be caller-supplied via X-Set-Cookie while the image URL is page-supplied,
     * so sending them would turn `<img src="https://evil.example/x.png">` into a
     * credential-exfiltration primitive.
     */
    async download(
        rawUrl: string,
        options: { referer?: string; userAgent?: string; signal?: AbortSignal; },
    ): Promise<DownloadOutcome> {
        let current: URL;
        try {
            current = new URL(rawUrl);
        } catch (_err) {
            return { ok: false, reason: 'blocked' };
        }

        for (let hop = 0; hop <= IMAGE_MAX_REDIRECTS; hop++) {
            if (!await this.isSafeTarget(current)) {
                return { ok: false, reason: 'blocked' };
            }

            const abort = new AbortController();
            // Armed through the body read, not just to the headers: a server that answers
            // instantly and then dribbles bytes would otherwise face no deadline at all.
            const timer = setTimeout(() => abort.abort(), IMAGE_FETCH_TIMEOUT_MS);
            const onOuterAbort = () => abort.abort();
            options.signal?.addEventListener('abort', onOuterAbort, { once: true });

            try {
                // Credentials are stripped: a URL from the page must not make us send
                // Basic auth, and no Authorization header is ever added.
                const target = new URL(current.toString());
                target.username = '';
                target.password = '';

                const response = await fetch(target, {
                    redirect: 'manual',
                    signal: abort.signal,
                    headers: {
                        accept: 'image/*',
                        ...(options.referer ? { referer: options.referer } : {}),
                        ...(options.userAgent ? { 'user-agent': options.userAgent } : {}),
                    },
                });

                if (response.status >= 300 && response.status < 400) {
                    const location = response.headers.get('location');
                    if (!location) {
                        return { ok: false, reason: 'http-error' };
                    }
                    // Followed by hand so the next hop passes the same checks; `redirect:
                    // 'follow'` would jump straight into a private address.
                    current = new URL(location, current);
                    continue;
                }
                if (!response.ok) {
                    return { ok: false, reason: 'http-error' };
                }
                if (declaredLengthExceeds(response, IMAGE_MAX_BYTES)) {
                    return { ok: false, reason: 'too-large' };
                }

                const { buffer, reason } = await readCapped(response, IMAGE_MAX_BYTES);
                if (!buffer) {
                    return { ok: false, reason: reason === 'too-large' ? 'too-large' : 'read-failed' };
                }

                return { ok: true, bytes: buffer };
            } catch (err: any) {
                if (err?.name === 'AbortError') {
                    return { ok: false, reason: 'timeout' };
                }
                this.logger.debug?.(`Image fetch failed for ${redactUrl(current.toString())}: ${err?.message}`);
                return { ok: false, reason: 'read-failed' };
            } finally {
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', onOuterAbort);
            }
        }

        return { ok: false, reason: 'too-many-redirects' };
    }

    /**
     * The SSRF check, run per redirect hop.
     *
     * The hostname test alone is not enough here. A caller-supplied crawl target is one
     * hostname we can reason about; a page supplies dozens, so a name that resolves to a
     * private address is a realistic attack rather than a theoretical one. Resolving first
     * closes the obvious case — a TOCTOU window remains between this lookup and the
     * socket, which would need a custom connect-time lookup to close entirely.
     */
    private async isSafeTarget(url: URL): Promise<boolean> {
        if (!['http:', 'https:'].includes(url.protocol)) {
            return false;
        }
        if (!isValidHostname(url.hostname) || isLoopbackOrPrivateHostname(url.hostname)) {
            this.logger.warn(`Refusing image fetch to ${url.hostname}`);
            return false;
        }

        const bare = url.hostname.replace(/^\[|\]$/g, '');
        // An IP literal was already judged above; only names need resolving.
        if (/^[\d.]+$/.test(bare) || bare.includes(':')) {
            return true;
        }

        try {
            const addresses = await dns.lookup(bare, { all: true });
            const unsafe = addresses.find((a) => isLoopbackOrPrivateHostname(a.address));
            if (unsafe) {
                this.logger.warn(`Refusing image fetch: ${bare} resolves to ${unsafe.address}`);
                return false;
            }
        } catch (_err) {
            // Unresolvable is not a security failure; let fetch report it normally.
            return true;
        }

        return true;
    }
}
