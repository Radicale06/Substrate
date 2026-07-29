import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CrawlCacheModule } from './cache/crawl-cache.module';
import { HealthModule } from './health/health.module';
import { V1FallbackModule } from './common/v1-fallback.module';
import { InferenceModule } from './inference/inference.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReaderModule } from './reader/reader.module';
import { SearchModule } from './search/search.module';
import { SegmentModule } from './segment/segment.module';
import { VectorsModule } from './vectors/vectors.module';

/**
 * Import order is load-bearing.
 *
 * Nest registers routes in module insertion order, and ReaderModule declares a catch-all
 * that treats any unmatched path as a URL to crawl. It must therefore come last, or it
 * would swallow /health, /v1/search and /v1/segment before their controllers ever ran.
 *
 * `controllers` stays empty for the same reason: controllers declared on the root module
 * register ahead of every imported module.
 */
@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true, cache: true }),
        PrismaModule,
        HealthModule,
        CrawlCacheModule,
        SegmentModule,
        SearchModule,
        InferenceModule,
        VectorsModule,
        V1FallbackModule, // unknown /v1 paths -> 404, before the catch-all
        ReaderModule, // catch-all: must stay last
    ],
    controllers: [],
})
export class AppModule { }
