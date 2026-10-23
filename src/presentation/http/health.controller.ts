import { EntityManager } from '@mikro-orm/postgresql';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { SqsService } from '../../infrastructure/messaging/sqs.service';
import { MetricsService } from '../../infrastructure/observability/metrics.service';

@Controller()
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqsService: SqsService,
    private readonly metrics: MetricsService,
  ) {}

  @Get('health/live')
  live() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('health/ready')
  async ready(@Res() res: Response) {
    let postgresUp = false;
    try {
      await this.em.getConnection().execute('SELECT 1');
      postgresUp = true;
    } catch {
      postgresUp = false;
    }

    const sqsUp = await this.sqsService.isReachable();
    const isReady = postgresUp && sqsUp;

    res.status(isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: isReady ? 'ready' : 'degraded',
      checks: {
        postgresql: postgresUp ? 'up' : 'down',
        sqs: sqsUp ? 'up' : 'down',
      },
      timestamp: new Date().toISOString(),
    });
  }

  @Get('metrics')
  getMetrics() {
    return this.metrics.getSnapshot();
  }
}