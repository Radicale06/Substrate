import { Module } from '@nestjs/common';
import { CrawlerModule } from '../crawler/crawler.module';
import { RenderingModule } from '../rendering/rendering.module';
import { CrawlController } from './crawl.controller';
import { CrawlService } from './crawl.service';

@Module({
    imports: [CrawlerModule, RenderingModule],
    controllers: [CrawlController],
    providers: [CrawlService],
})
export class CrawlModule { }
