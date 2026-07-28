import { Module } from '@nestjs/common';
import { RenderingModule } from '../rendering/rendering.module';
import { HealthController } from './health.controller';

@Module({
    imports: [RenderingModule],
    controllers: [HealthController],
})
export class HealthModule { }
