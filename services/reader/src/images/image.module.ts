import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ImageDownloader } from './image-download';
import { ImageService } from './image.service';

/** Downloading and storing the images a crawled page references. */
@Module({
    imports: [StorageModule],
    providers: [ImageDownloader, ImageService],
    exports: [ImageService],
})
export class ImageModule { }
