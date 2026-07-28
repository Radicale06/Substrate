import { Module } from '@nestjs/common';
import { CrawlModule } from './crawl/crawl.module';
import { HealthModule } from './health/health.module';

/**
 * The reader service.
 *
 * Unlike the backend there is no catch-all route here, so module order carries no
 * meaning: this service is addressed by a normal endpoint, not by putting a URL in the path.
 */
@Module({
    imports: [HealthModule, CrawlModule],
})
export class AppModule { }
