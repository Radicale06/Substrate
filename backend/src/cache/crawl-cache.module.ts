import { Module } from '@nestjs/common';
import { CrawlCacheService } from './crawl-cache.service';

/** Named CrawlCacheModule rather than CacheModule to avoid confusion with @nestjs/cache-manager. */
@Module({
    providers: [CrawlCacheService],
    exports: [CrawlCacheService],
})
export class CrawlCacheModule { }
