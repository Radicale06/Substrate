import { Module } from '@nestjs/common';
import { ReaderClientModule } from '../reader/reader-client.module';
import { SegmentModule } from '../segment/segment.module';
import { InferenceClient } from './inference.client';
import { InferenceController } from './inference.controller';

/**
 * Embeddings and reranking, served by the model containers under services/.
 *
 * Imports the segmenter and reader clients because /v1/embeddings can chunk its input
 * first and can take a URL instead of text — the whole pipeline in one call.
 */
@Module({
    imports: [SegmentModule, ReaderClientModule],
    controllers: [InferenceController],
    providers: [InferenceClient],
    exports: [InferenceClient],
})
export class InferenceModule { }
