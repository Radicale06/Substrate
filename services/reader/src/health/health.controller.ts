import { Controller, Get } from '@nestjs/common';
import { BrowserService } from '../rendering/browser.service';

/** Liveness probe, used by the container healthcheck. */
@Controller('health')
export class HealthController {
    constructor(private readonly browserService: BrowserService) { }

    /**
     * Always 200 while the process is serving.
     *
     * The browser is reported rather than asserted: Chrome is launched lazily and
     * relaunched on crash, so a momentarily absent browser is normal operation. Failing
     * the check here would restart a container that is about to recover on its own.
     */
    @Get()
    check() {
        return {
            status: 'ok',
            browser: this.browserService.status,
        };
    }
}
