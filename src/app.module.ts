import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { OpenWalletUseCase } from './application/use-cases/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import {
  NoOpProviderIdentityAdapter,
  ProviderAuthGuard,
  ProviderIdentityPort,
} from './infrastructure/auth/provider-auth.guard';
import { OutboxPublisherWorker } from './infrastructure/messaging/outbox-publisher.worker';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager.consumer';
import { SqsService } from './infrastructure/messaging/sqs.service';
import { MetricsService } from './infrastructure/observability/metrics.service';
import mikroOrmConfig from './infrastructure/persistence/mikro-orm.config';
import { WagerTransactionRepository } from './infrastructure/persistence/repositories/wager-transaction.repository';
import { WalletRepository } from './infrastructure/persistence/repositories/wallet.repository';
import { DomainExceptionFilter } from './presentation/http/domain-exception.filter';
import { HealthController } from './presentation/http/health.controller';
import { WageringController } from './presentation/http/wagering.controller';
import { WalletsController } from './presentation/http/wallets.controller';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    MetricsService,
    WalletRepository,
    WagerTransactionRepository,
    OpenWalletUseCase,
    ProcessWagerTransactionUseCase,
    ReconcileWalletUseCase,
    SqsService,
    SqsWagerConsumer,
    OutboxPublisherWorker,
    {
      provide: ProviderIdentityPort,
      useClass: NoOpProviderIdentityAdapter,
    },
    {
      provide: APP_GUARD,
      useClass: ProviderAuthGuard,
    },
    {
      provide: APP_FILTER,
      useClass: DomainExceptionFilter,
    },
  ],
})
export class AppModule {}