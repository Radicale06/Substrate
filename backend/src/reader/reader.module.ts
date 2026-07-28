import { Module } from '@nestjs/common';
import { CrawlCacheModule } from '../cache/crawl-cache.module';
import { ReaderClientModule } from './reader-client.module';
import { ReaderController } from './reader.controller';

/**
 * The `GET /<url>` endpoint. Imported LAST by AppModule, because its catch-all route
 * claims every path that no earlier controller matched.
 */
@Module({
    imports: [ReaderClientModule, CrawlCacheModule],
    controllers: [ReaderController],
})
export class ReaderModule { }
