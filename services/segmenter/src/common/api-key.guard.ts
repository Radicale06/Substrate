import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { env } from '../config/env';

/**
 * Requires `Authorization: Bearer <SEGMENTER_API_KEY>`, and does nothing when no key is
 * configured — the default compose stack keeps this service on an internal network.
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

    return a.length === b.length && timingSafeEqual(a, b);
}
