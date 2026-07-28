import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { env } from '../config/env';

/**
 * Requires `Authorization: Bearer <READER_API_KEY>`, and does nothing at all when no key
 * is configured — the default compose stack keeps this service on an internal network,
 * where a mandatory credential would be friction without benefit.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const expected = env.apiKey;
        if (!expected) {
            return true;
        }

        const header = context.switchToHttp().getRequest<Request>().headers.authorization;
        if (!header || !matches(header, `Bearer ${expected}`)) {
            throw new UnauthorizedException('Invalid or missing API key');
        }

        return true;
    }
}

/** Constant-time compare, so a wrong key cannot be recovered a byte at a time. */
function matches(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);

    // timingSafeEqual throws on a length mismatch, which leaks length by itself; compare
    // against a same-length buffer and fold the length check into the result.
    return a.length === b.length && timingSafeEqual(a, b);
}
