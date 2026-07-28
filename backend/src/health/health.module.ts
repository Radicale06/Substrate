import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { StatusController } from './status.controller';

@Module({ controllers: [HealthController, StatusController] })
export class HealthModule { }
