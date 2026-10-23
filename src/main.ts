import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { StructuredLogger } from './infrastructure/observability/metrics.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.enableShutdownHooks();

  const orm = app.get(MikroORM);
  await orm.getMigrator().up();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  StructuredLogger.info('application_started', { port });
}

bootstrap();