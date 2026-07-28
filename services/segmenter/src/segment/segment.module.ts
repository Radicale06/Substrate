import { Module } from '@nestjs/common';
import { EmbeddingsClient } from './embeddings.client';
import { SegmentController } from './segment.controller';
import { SegmenterService } from './segmenter.service';

@Module({
    controllers: [SegmentController],
    providers: [SegmenterService, EmbeddingsClient],
    exports: [SegmenterService],
})
export class SegmentModule { }
