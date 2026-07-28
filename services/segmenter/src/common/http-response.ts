import type { Request, Response } from 'express';

export function sendText(res: Response, body: string, statusCode = 200) {
    res.status(statusCode).type('text/plain').send(body);
}

/** Envelope shape matching the hosted Reader API, so existing clients can point here. */
export function sendJson(res: Response, data: unknown, statusCode = 200) {
    res.status(statusCode).json({
        code: statusCode,
        status: statusCode * 100,
        data,
    });
}

export function sendJsonError(res: Response, message: string, statusCode: number) {
    res.status(statusCode).json({
        code: statusCode,
        status: statusCode * 100,
        message,
    });
}

/**
 * Whether the caller asked for JSON. `text/plain` is listed first so that a wildcard
 * Accept header — what curl sends by default — still gets the plain-text response.
 */
export function wantsJson(req: Request): boolean {
    return req.accepts(['text/plain', 'application/json']) === 'application/json';
}
