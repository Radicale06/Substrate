import { Module } from '@nestjs/common';
import { RenderingModule } from '../rendering/rendering.module';
import { CrawlerService } from './crawler.service';

/** Crawl orchestration: browser capture, PDF extraction and DOM narrowing. */
@Module({
    imports: [RenderingModule],
    providers: [CrawlerService],
    exports: [CrawlerService],
})
export class CrawlerModule { }
