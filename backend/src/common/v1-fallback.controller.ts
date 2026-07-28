import { All, Controller, NotFoundException, Req } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Catches unknown `/v1/...` paths.
 *
 * Without this they would reach the reader's catch-all and be treated as a URL to crawl,
 * so a typo in an endpoint name would come back as "Invalid URL or TLD" instead of a
 * plain 404. Registered after the real /v1 controllers and before the reader.
 */
@Controller('v1')
export class V1FallbackController {
    @All('{*splat}')
    notFound(@Req() req: Request): never {
        throw new NotFoundException(`Unknown endpoint: ${req.path}`);
    }
}
