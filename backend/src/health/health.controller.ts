import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Liveness probe, used by the container healthcheck. */
@Controller('health')
export class HealthController {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Always 200 while the process is serving. The cache is optional, so a database that
     * is absent or down is reported rather than failing the check — a non-200 here would
     * put the container into a restart loop over a non-essential dependency.
     */
    @Get()
    async check() {
        return {
            status: 'ok',
            cache: this.prisma.available
                ? (await this.prisma.healthy() ? 'connected' : 'unreachable')
                : 'disabled',
        };
    }
}
