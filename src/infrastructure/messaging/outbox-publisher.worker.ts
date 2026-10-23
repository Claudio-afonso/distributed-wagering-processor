import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { MetricsService, StructuredLogger } from '../observability/metrics.service';
import { WagerTransactionRepository } from '../persistence/repositories/wager-transaction.repository';
import { SqsService } from './sqs.service';

@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private isRunning = false;
  private outboxTimer?: Timer;
  private pendingRefTimer?: Timer;

  constructor(
    private readonly em: EntityManager,
    private readonly txRepo: WagerTransactionRepository,
    private readonly sqsService: SqsService,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.DISABLE_BACKGROUND_WORKERS === 'true') return;
    this.startWorkers();
  }

  startWorkers(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const runOutbox = async () => {
      if (!this.isRunning) return;
      try {
        await this.publishPendingBatch();
      } catch (err) {
        StructuredLogger.warn('outbox_worker_error', { error: (err as Error)?.message });
      } finally {
        if (this.isRunning) {
          this.outboxTimer = setTimeout(runOutbox, 250);
        }
      }
    };

    const runPendingRefs = async () => {
      if (!this.isRunning) return;
      try {
        await this.processWagerUseCase.retryPendingReferencesBatch();
      } catch (err) {
        StructuredLogger.warn('pending_ref_worker_error', { error: (err as Error)?.message });
      } finally {
        if (this.isRunning) {
          this.pendingRefTimer = setTimeout(runPendingRefs, 500);
        }
      }
    };

    runOutbox();
    runPendingRefs();
  }

  /**
   * Reivindica um lote de mensagens da outbox via FOR UPDATE SKIP LOCKED,
   * publica no SQS e marca como publicado. Se falhar, agenda retry com backoff.
   */
  async publishPendingBatch(batchSize: number = 50): Promise<number> {
    const emFork = this.em.fork();

    const claimedMessages = await emFork.transactional(async (txEm) => {
      return await this.txRepo.claimDueOutboxMessages(txEm, batchSize);
    });

    let publishedCount = 0;

    for (const message of claimedMessages) {
      const itemEm = this.em.fork();
      try {
        const eventId = String(message.payload.eventId ?? message.id);
        await this.sqsService.publishIntegrationEvent(
          message.aggregateId,
          eventId,
          message.payload,
        );

        message.markPublished(new Date());
        await this.txRepo.updateOutboxMessage(itemEm, message);
        publishedCount += 1;
      } catch (err) {
        this.metrics.incrementRetry('outbox');
        message.scheduleRetry(new Date());
        await this.txRepo.updateOutboxMessage(itemEm, message);
        StructuredLogger.warn('outbox_publish_attempt_failed', {
          outboxId: message.id,
          eventType: message.eventType,
          attempts: message.attempts,
          error: (err as Error)?.message,
        });
      }
    }

    const lagMs = await this.txRepo.getOldestUnpublishedOutboxLagMs(this.em.fork());
    this.metrics.setOutboxLagMs(lagMs);

    return publishedCount;
  }

  onApplicationShutdown(): void {
    this.isRunning = false;
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    if (this.pendingRefTimer) clearTimeout(this.pendingRefTimer);
  }
}