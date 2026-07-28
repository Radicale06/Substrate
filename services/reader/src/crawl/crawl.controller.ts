import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../common/api-key.guard';
import { CrawlRequest } from './crawl-request.dto';
import type { CrawlResult } from './crawl-result';
import { CrawlService } from './crawl.service';

/**
 * The service's only real endpoint.
 *
 * One crawl per call, answered synchronously — the caller owns retries, caching and
 * concurrency, because it is the one that knows what the work is for.
 */
@Controller('crawl')
@UseGuards(ApiKeyGuard)
export class CrawlController {
    constructor(private readonly crawlService: CrawlService) { }

    // Nest answers POST with 201 by default; this creates nothing.
    @Post()
    @HttpCode(HttpStatus.OK)
    async crawl(@Body() body: unknown): Promise<CrawlResult> {
        // Validated by hand rather than by ValidationPipe: the selector and cookie fields
        // are unions that class-validator cannot describe without losing the good messages.
        return this.crawlService.crawl(CrawlRequest.from(body));
    }
}
