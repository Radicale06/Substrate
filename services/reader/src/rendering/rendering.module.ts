import { Module } from '@nestjs/common';
import { ImageModule } from '../images/image.module';
import { StorageModule } from '../storage/storage.module';
import { BrowserService } from './browser.service';
import { DomService } from './dom.service';
import { PdfService } from './pdf.service';
import { SnapshotFormatter } from './snapshot-formatter';

/** Everything that turns a URL into a rendered, formatted page. */
@Module({
    imports: [StorageModule, ImageModule],
    providers: [BrowserService, DomService, PdfService, SnapshotFormatter],
    exports: [BrowserService, DomService, PdfService, SnapshotFormatter],
})
export class RenderingModule { }
