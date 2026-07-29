import {
    ArgumentsHost,
    Catch,
    type ExceptionFilter,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
    BadRequestError,
    ConflictError,
    NotFoundError,
    SecurityCompromiseError,
    ServiceCrashedError,
    UpstreamFailureError,
} from './errors';
import { sendJsonError, sendText, wantsJson } from './http-response';

/** Domain errors carry no HTTP knowledge, so the mapping lives here instead. */
const STATUS_BY_ERROR: Array<[new (...args: any[]) => Error, HttpStatus]> = [
    [BadRequestError, HttpStatus.BAD_REQUEST],
    [NotFoundError, HttpStatus.NOT_FOUND],
    [ConflictError, HttpStatus.CONFLICT],
    [SecurityCompromiseError, HttpStatus.FORBIDDEN],
    [ServiceCrashedError, HttpStatus.SERVICE_UNAVAILABLE],
    [UpstreamFailureError, HttpStatus.BAD_GATEWAY],
];

/**
 * Maps thrown errors onto responses, matching the content type the caller asked for so
 * a JSON client never receives a plain-text error body.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(DomainExceptionFilter.name);

    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const res = ctx.getResponse<Response>();
        const req = ctx.getRequest<Request>();

        if (res.headersSent) {
            return;
        }

        const { status, message } = this.describe(exception);
        if (status >= 500) {
            this.logger.error(`${req.method} ${req.url} -> ${status}: ${message}`);
        }

        if (wantsJson(req)) {
            sendJsonError(res, message, status);
            return;
        }
        sendText(res, message, status);
    }

    private describe(exception: unknown): { status: HttpStatus; message: string; } {
        for (const [type, status] of STATUS_BY_ERROR) {
            if (exception instanceof type) {
                return { status, message: (exception as Error).message };
            }
        }

        if (exception instanceof HttpException) {
            const response = exception.getResponse();
            const message = typeof response === 'string'
                ? response
                : (response as any)?.message ?? exception.message;

            return {
                status: exception.getStatus(),
                message: Array.isArray(message) ? message.join('; ') : String(message),
            };
        }

        // Express middleware (serve-static, body-parser) throws plain errors that carry
        // their own status; honour it so a missing screenshot stays a 404, not a 500.
        const status = (exception as any)?.status ?? (exception as any)?.statusCode;
        if (typeof status === 'number' && status >= 400 && status < 600) {
            return {
                status,
                message: status === HttpStatus.NOT_FOUND
                    ? 'Not found'
                    : (exception as Error)?.message ?? 'Request failed',
            };
        }

        return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            message: 'Internal server error',
        };
    }
}
