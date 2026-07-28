/**
 * Body reading with a hard size cap.
 *
 * Shared by the PDF and image download paths, which face the same problem: the remote is
 * untrusted and `response.arrayBuffer()` materializes the entire body before any size
 * check can run. A response that omits Content-Length — chunked transfer, or any HTTP/2
 * response — could therefore hand the process an unbounded allocation.
 */

export interface CappedReadResult {
    /** The body, or null when it exceeded the cap or could not be read. */
    buffer: Buffer | null;
    /** Why it is null, for the caller's log line. */
    reason?: 'too-large' | 'read-failed' | 'no-body';
}

/** Reads the body a chunk at a time, abandoning it the moment it exceeds `maxBytes`. */
export async function readCapped(response: Response, maxBytes: number): Promise<CappedReadResult> {
    if (!response.body) {
        return { buffer: null, reason: 'no-body' };
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
            if (received > maxBytes) {
                // Cancel rather than just stopping: it closes the connection so the
                // sender stops pushing bytes we have already decided to discard.
                await reader.cancel().catch(() => undefined);
                return { buffer: null, reason: 'too-large' };
            }
            chunks.push(Buffer.from(value));
        }
    } catch (_err) {
        return { buffer: null, reason: 'read-failed' };
    }

    return { buffer: Buffer.concat(chunks) };
}

/**
 * Whether a Content-Length header already rules the response out.
 *
 * A cheap pre-check that avoids opening the body at all when the server is honest about
 * the size. An absent or bogus header simply falls through to {@link readCapped}.
 */
export function declaredLengthExceeds(response: Response, maxBytes: number): boolean {
    const declared = Number(response.headers.get('content-length') || 0);

    return Number.isFinite(declared) && declared > maxBytes;
}
