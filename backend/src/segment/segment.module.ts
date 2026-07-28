import { Module } from '@nestjs/common';
import { SegmentController } from './segment.controller';
import { SegmenterClient } from './segmenter.client';

/**
 * Exports the client so /v1/embeddings can chunk before embedding. The controller stays
 * here; anything that only needs to chunk imports SegmenterClientModule instead.
 */
@Module({
    controllers: [SegmentController],
    providers: [SegmenterClient],
    exports: [SegmenterClient],
})
export class SegmentModule { }
