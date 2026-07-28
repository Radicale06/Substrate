import { Module } from '@nestjs/common';
import { ImageStore } from './image-store';
import { ScreenshotStore } from './screenshot-store';

@Module({
    providers: [ScreenshotStore, ImageStore],
    exports: [ScreenshotStore, ImageStore],
})
export class StorageModule { }
