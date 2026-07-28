import { Module } from '@nestjs/common';
import { V1FallbackController } from './v1-fallback.controller';

/** Must be imported after every real /v1 module and before ReaderModule. */
@Module({ controllers: [V1FallbackController] })
export class V1FallbackModule { }
