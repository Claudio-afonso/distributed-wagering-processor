import { Message } from '@aws-sdk/client-sqs';
import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import {
  DomainValidationError,
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../domain/errors/domain.errors';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction.entity';
import { MetricsService, StructuredLogger } from '../observability/metrics.service';
import { SqsService } from './sqs.service';

const CONSUMER_NAME = 'sqs-wager-transactions-consumer';
const MAX_DELIVERY_ATTEMPTS = 3;

@Injectable()
export class SqsWagerConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private isRunning = false;
  private isShuttingDown = false;
  private pollTimer?: Timer;
  private readonly inFlightMessages = new Map<string, { receiptHandle: string; promise: Promise<void> }>();

  constructor(
    private readonly sqsService: SqsService,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.DISABLE_BACKGROUND_WORKERS === 'true') return;
    this.startPolling();
  }

  startPolling(intervalMs: number = 300): void {
    if (this.isRunning) return;
    this.isRunning = true;
    const loop = async () => {
      if (this.isShuttingDown || !this.isRunning) return;
      try {
        await this.pollOnce();
      } catch (err) {
        StructuredLogger.warn('sqs_consumer_poll_error', {
          error: (err as Error)?.message,
        });
      } finally {
        if (!this.isShuttingDown && this.isRunning) {
          this.pollTimer = setTimeout(loop, intervalMs);
        }
      }
    };
    loop();
  }

  async pollOnce(): Promise<number> {
    if (this.isShuttingDown) return 0;
    const messages = await this.sqsService.receiveWagerMessages(10, 0);
    if (messages.length === 0) return 0;

    await Promise.all(
      messages.map(async (msg) => {
        const msgKey = msg.MessageId ?? Math.random().toString();
        const promise = this.handleSingleMessage(msg);
        if (msg.ReceiptHandle) {
          this.inFlightMessages.set(msgKey, { receiptHandle: msg.ReceiptHandle, promise });
        }
        try {
          await promise;
        } finally {
          this.inFlightMessages.delete(msgKey);
        }
      }),
    );

    return messages.length;
  }

  async handleSingleMessage(msg: Message): Promise<void> {
    const receiptHandle = msg.ReceiptHandle;
    const rawBody = msg.Body ?? '';
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? '1');

    if (!receiptHandle) return;

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      // JSON inválido é erro permanente -> DLQ imediata
      await this.moveToDlqAndAck(rawBody, receiptHandle, 'INVALID_JSON_ENVELOPE');
      return;
    }

    const messageId: string | undefined = parsed?.messageId ?? msg.MessageId;
    const data = parsed?.data;

    if (!messageId || parsed?.type !== 'WagerTransactionRequested' || !data) {
      await this.moveToDlqAndAck(rawBody, receiptHandle, 'INVALID_MESSAGE_CONTRACT');
      return;
    }

    try {
      await this.processWagerUseCase.execute({
        idempotencyKey: data.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}`,
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind as WagerTransactionKind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
        correlationId: messageId,
        inboxContext: {
          consumerName: CONSUMER_NAME,
          messageId,
        },
      });

      // Commit concluído com sucesso (PROCESSED, REJECTED ou PENDING_REFERENCE) -> ACK
      await this.sqsService.ackMessage(this.sqsService.wagerQueueUrl, receiptHandle);
    } catch (err) {
      // Erros permanentes (payload inválido, conflito de idempotência, wallet inexistente) -> DLQ
      if (
        err instanceof DomainValidationError ||
        err instanceof IdempotencyConflictError ||
        err instanceof WalletNotFoundError
      ) {
        await this.moveToDlqAndAck(
          rawBody,
          receiptHandle,
          `${err.name}:${(err as any).code ?? err.message}`,
          data.walletId,
        );
        return;
      }

      // Erro transitório (ex: lock timeout, queda momentânea do banco)
      this.metrics.incrementRetry('sqs');
      if (receiveCount >= MAX_DELIVERY_ATTEMPTS) {
        await this.moveToDlqAndAck(
          rawBody,
          receiptHandle,
          `MAX_RETRIES_EXCEEDED:${(err as Error)?.message}`,
          data.walletId,
        );
        return;
      }

      // Backoff exponencial via VisibilityTimeout
      const backoffSeconds = Math.min(30, Math.pow(2, receiveCount));
      await this.sqsService.releaseVisibility(
        this.sqsService.wagerQueueUrl,
        receiptHandle,
        backoffSeconds,
      );
    }
  }

  private async moveToDlqAndAck(
    rawBody: string,
    receiptHandle: string,
    reason: string,
    groupId: string = 'dlq-group',
  ): Promise<void> {
    this.metrics.incrementDlqMessages();
    StructuredLogger.warn('sqs_message_moved_to_dlq', { reason });
    await this.sqsService.sendToDlq(rawBody, reason, groupId);
    await this.sqsService.ackMessage(this.sqsService.wagerQueueUrl, receiptHandle);
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.isShuttingDown = true;
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    if (this.inFlightMessages.size === 0) return;

    StructuredLogger.info('sqs_consumer_graceful_shutdown_started', {
      signal,
      inFlightCount: this.inFlightMessages.size,
    });

    const entries = Array.from(this.inFlightMessages.values());
    const timeoutPromise = new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), 5000));
    const settledPromise = Promise.allSettled(entries.map((e) => e.promise)).then(() => 'DONE' as const);

    const outcome = await Promise.race([settledPromise, timeoutPromise]);

    if (outcome === 'TIMEOUT') {
      // Devolve a visibilidade das mensagens que não terminaram a tempo
      for (const remaining of this.inFlightMessages.values()) {
        try {
          await this.sqsService.releaseVisibility(
            this.sqsService.wagerQueueUrl,
            remaining.receiptHandle,
            0,
          );
        } catch {
          // Ignora falha no shutdown
        }
      }
    }
  }
}