import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { SegmentModule } from './segment/segment.module';

/** The segmenter service. No catch-all route, so module order carries no meaning. */
@Module({
    imports: [HealthModule, SegmentModule],
})
export class AppModule { }
