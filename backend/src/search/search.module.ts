import { Module } from '@nestjs/common';
import { ReaderClientModule } from '../reader/reader-client.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearxngProvider } from './searxng.provider';

@Module({
    imports: [ReaderClientModule],
    controllers: [SearchController],
    providers: [SearchService, SearxngProvider],
    exports: [SearchService],
})
export class SearchModule { }
