import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { SegmenterClient } from './segmenter.client';

/**
 * `POST /v1/segment` — the public face of the segmenter service.
 *
 * A pass-through on purpose: the service owns validation, so duplicating it here would
 * mean two places to keep in step and two different error messages for the same mistake.
 */
@Controller('v1/segment')
export class SegmentController {

    constructor(private readonly segmenter: SegmenterClient) { }

    @Post()
    @HttpCode(HttpStatus.OK)
    async handle(@Body() body: any) {
        return this.segmenter.segment(body ?? {});
    }
}
