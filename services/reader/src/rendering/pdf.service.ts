import { Injectable, Logger } from '@nestjs/common';
import {
    PDF_FETCH_TIMEOUT_MS,
    PDF_MAX_BYTES,
    PDF_MAX_PAGES,
    PDF_MAX_REDIRECTS,
} from '../config/constants';
import { isLoopbackOrPrivateHostname } from '../security/ssrf-guard';
import { redactUrl } from '../common/url';
import type { PageSnapshot } from './page-snapshot';

/** `%PDF-` — the header every PDF starts with. */
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

/** Cheap pre-check so we only take the direct-fetch path for likely PDFs. */
export function looksLikePdf(url: URL): boolean {
    return /\.pdf$/i.test(url.pathname);
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Extracts text from PDFs.
 *
 * Chrome renders PDFs in a built-in viewer whose contents the page scripts cannot read,
 * so the browser path yields nothing for them. These are fetched directly and parsed
 * with pdf.js instead.
 */
@Injectable()
export class PdfService {
    private readonly logger = new Logger(PdfService.name);
    private pdfjs?: any;

    /**
     * pdf.js is ESM-only and weighs several MB, so it is imported on first use rather
     * than at startup.
     */
    private async library() {
        this.pdfjs ??= await import('pdfjs-dist/legacy/build/pdf.mjs');

        return this.pdfjs;
    }

    /** Returns a snapshot, or null when the URL is not a PDF or could not be read. */
    async extract(url: URL, timeoutMs = PDF_FETCH_TIMEOUT_MS): Promise<PageSnapshot | null> {
        const bytes = await this.download(url, timeoutMs);
        if (!bytes) {
            return null;
        }

        try {
            return await this.toSnapshot(url, bytes);
        } catch (err: any) {
            this.logger.warn(`Failed to parse PDF at ${redactUrl(url.toString())}`, { err: err?.message });
            return null;
        }
    }

    /**
     * Fetches the document, following redirects manually so every hop passes the same
     * SSRF check the initial target did — otherwise a public URL could bounce us into
     * the private network.
     */
    private async download(url: URL, timeoutMs: number): Promise<Buffer | null> {
        let current = new URL(url.toString());

        for (let hop = 0; hop <= PDF_MAX_REDIRECTS; hop++) {
            if (isLoopbackOrPrivateHostname(current.hostname)) {
                this.logger.warn(`Refusing PDF fetch to a private address: ${redactUrl(current.toString())}`);
                return null;
            }

            const abort = new AbortController();
            // Armed until the body has been read, not just until the headers arrive: a
            // server that answers immediately and then dribbles bytes forever would
            // otherwise face no deadline at all.
            const timer = setTimeout(() => abort.abort(), timeoutMs);
            try {
                let response: Response;
                try {
                    response = await fetch(current, {
                        redirect: 'manual',
                        signal: abort.signal,
                        headers: { accept: 'application/pdf,*/*' },
                    });
                } catch (err: any) {
                    this.logger.warn(`Failed to fetch PDF at ${redactUrl(current.toString())}`, { err: err?.message });
                    return null;
                }

                if (response.status >= 300 && response.status < 400) {
                    const location = response.headers.get('location');
                    if (!location) {
                        return null;
                    }
                    current = new URL(location, current);
                    continue;
                }
                if (!response.ok) {
                    this.logger.warn(`PDF fetch returned ${response.status} for ${redactUrl(current.toString())}`);
                    return null;
                }

                // Cheap rejection when the server is honest about the size.
                const declaredLength = Number(response.headers.get('content-length') || 0);
                if (declaredLength > PDF_MAX_BYTES) {
                    this.logger.warn(`PDF too large (${declaredLength} bytes), skipping`);
                    return null;
                }

                const buffer = await this.readCapped(response, current);
                if (!buffer) {
                    return null;
                }
                // Trust the bytes over the Content-Type header, which is often wrong.
                if (!buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
                    return null;
                }

                return buffer;
            } finally {
                clearTimeout(timer);
            }
        }

        this.logger.warn(`Too many redirects fetching PDF at ${redactUrl(url.toString())}`);

        return null;
    }

    /**
     * Reads the body a chunk at a time, giving up the moment it exceeds the cap.
     *
     * `response.arrayBuffer()` would materialize the whole thing first, so a response
     * that omits Content-Length — chunked transfer, or any HTTP/2 response — could hand
     * this process an unbounded allocation before the size check ever ran.
     */
    private async readCapped(response: Response, url: URL): Promise<Buffer | null> {
        if (!response.body) {
            return null;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        const reader = response.body.getReader();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                received += value.byteLength;
                if (received > PDF_MAX_BYTES) {
                    this.logger.warn(`PDF exceeded ${PDF_MAX_BYTES} bytes, abandoning ${redactUrl(url.toString())}`);
                    await reader.cancel().catch(() => undefined);
                    return null;
                }
                chunks.push(Buffer.from(value));
            }
        } catch (err: any) {
            this.logger.warn(`Failed to read PDF body at ${redactUrl(url.toString())}`, { err: err?.message });
            return null;
        }

        return Buffer.concat(chunks);
    }

    private async toSnapshot(url: URL, bytes: Buffer): Promise<PageSnapshot> {
        const pdfjs = await this.library();
        // Destroy is on the loading task, not the document proxy.
        const loadingTask = pdfjs.getDocument({
            data: new Uint8Array(bytes),
            // Keep the parser inert: no scripting, no network font fetches.
            isEvalSupported: false,
            disableFontFace: true,
            useSystemFonts: false,
        });
        const doc = await loadingTask.promise;

        try {
            const pageCount = Math.min(doc.numPages, PDF_MAX_PAGES);
            const pages: string[] = [];
            for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
                const page = await doc.getPage(pageNumber);
                const content = await page.getTextContent();
                // pdf.js emits positioned fragments; hasEOL marks a visual line break.
                const text = content.items
                    .map((item: any) => (item.str ?? '') + (item.hasEOL ? '\n' : ''))
                    .join('')
                    .replace(/[ \t]+/g, ' ')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                if (text) {
                    pages.push(text);
                }
                page.cleanup();
            }

            if (doc.numPages > pageCount) {
                this.logger.warn(`PDF truncated at ${pageCount} of ${doc.numPages} pages`);
            }

            const metadata = await doc.getMetadata().catch(() => undefined);
            const filename = decodeURIComponent(url.pathname.split('/').pop() || 'document.pdf');
            const title = (metadata?.info?.Title || '').trim() || filename;
            const text = pages.join('\n\n');
            const html = this.toHtml(title, pages);

            return {
                title,
                href: url.toString(),
                html,
                text,
                parsed: {
                    title,
                    content: html,
                    textContent: text,
                    length: text.length,
                    excerpt: text.slice(0, 250),
                    publishedTime: metadata?.info?.CreationDate || undefined,
                },
            } as PageSnapshot;
        } finally {
            await loadingTask.destroy().catch(() => void 0);
        }
    }

    /** One section per page, so Turndown produces readable markdown downstream. */
    private toHtml(title: string, pages: string[]): string {
        const body = pages
            .map((page) => page
                .split(/\n{2,}/)
                .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
                .join('\n'))
            .join('\n');

        return `<html><head><title>${escapeHtml(title)}</title></head><body><article>${body}</article></body></html>`;
    }
}
