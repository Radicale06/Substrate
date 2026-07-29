import { Module } from '@nestjs/common';
import { InferenceClient } from './inference.client';
import { InferenceController } from './inference.controller';

/**
 * Embeddings and reranking, served by the model containers under services/.
 *
 * Depends on nothing else: embedding does not chunk, so there is no reason for this to
 * reach into the segmenter or the reader. Callers compose the pipeline themselves.
 */
@Module({
    controllers: [InferenceController],
    providers: [InferenceClient],
    exports: [InferenceClient],
})
export class InferenceModule { }
