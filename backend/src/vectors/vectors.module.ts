import { Module } from '@nestjs/common';
import { VectorsClient } from './vectors.client';
import { VectorsController } from './vectors.controller';

/** Vector storage and search, served by the vectors container under services/. */
@Module({
    controllers: [VectorsController],
    providers: [VectorsClient],
    exports: [VectorsClient],
})
export class VectorsModule { }
