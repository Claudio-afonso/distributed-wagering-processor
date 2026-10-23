import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { FailureCode } from '../../../domain/errors/domain.errors';
import { InboxMessage, OutboxMessage } from '../../../domain/messaging/inbox-outbox.entities';
import { IntegrationEvent } from '../../../domain/shared/integration-event';
import { Money } from '../../../domain/shared/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/wager-transaction.entity';
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
} from '../entities/persistence.entities';

@Injectable()
export class WagerTransactionRepository {
  async save(em: EntityManager, tx: WagerTransaction): Promise<void> {
    const existing = await em.findOne(WagerTransactionRecord, { id: tx.id });
    const data = {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.toJSON().amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      observedBalanceAfter: tx.observedBalanceAfter ? tx.observedBalanceAfter.toJSON().amount : null,
      retryCount: tx.retryCount,
      nextRetryAt: tx.nextRetryAt ?? null,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt ?? null,
    };

    if (!existing) {
      const record = em.create(WagerTransactionRecord, data);
      await em.persistAndFlush(record);
    } else {
      em.assign(existing, data);
      await em.flush();
    }
  }

  async findById(em: EntityManager, id: string): Promise<WagerTransaction | null> {
    const record = await em.findOne(WagerTransactionRecord, { id });
    return record ? this.toDomain(record) : null;
  }

  async findByIdempotencyKey(em: EntityManager, idempotencyKey: string): Promise<WagerTransaction | null> {
    const record = await em.findOne(WagerTransactionRecord, { idempotencyKey }, { refresh: true });
    return record ? this.toDomain(record) : null;
  }

  async findByProviderAndExternalId(
    em: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const record = await em.findOne(
      WagerTransactionRecord,
      { providerId, externalTransactionId },
      { refresh: true },
    );
    return record ? this.toDomain(record) : null;
  }

  async hasProcessedReversalOfKind(
    em: EntityManager,
    referenceTransactionId: string,
    kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  ): Promise<boolean> {
    const count = await em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  /**
   * Busca transações em PENDING_REFERENCE prontas para reprocessamento usando SKIP LOCKED
   */
  async claimDuePendingReferenceTransactions(
    em: EntityManager,
    limit: number = 25,
  ): Promise<WagerTransaction[]> {
    const rows = await em.getConnection().execute(
      `SELECT *
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY next_retry_at ASC NULLS FIRST
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows.map((r: any) => this.rawRowToDomain(r));
  }

  // ---- INBOX ----
  async findInboxMessage(
    em: EntityManager,
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null> {
    const record = await em.findOne(
      InboxMessageRecord,
      { consumerName, messageId },
      { refresh: true },
    );
    if (!record) return null;
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: new Date(record.receivedAt),
      processedAt: record.processedAt ? new Date(record.processedAt) : undefined,
    });
  }

  async saveInboxMessage(em: EntityManager, inbox: InboxMessage): Promise<void> {
    await em.getConnection().execute(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id)
       DO UPDATE SET processed_at = EXCLUDED.processed_at`,
      [
        inbox.consumerName,
        inbox.messageId,
        inbox.payloadHash,
        inbox.receivedAt,
        inbox.processedAt ?? null,
      ],
    );
  }

  // ---- OUTBOX ----
  async enqueueOutboxEvent(em: EntityManager, event: IntegrationEvent<unknown>): Promise<OutboxMessage> {
    const outbox = OutboxMessage.enqueue(event);
    const record = em.create(OutboxMessageRecord, {
      id: outbox.id,
      aggregateId: outbox.aggregateId,
      eventType: outbox.eventType,
      payload: outbox.payload as Record<string, unknown>,
      occurredAt: outbox.occurredAt,
      attempts: outbox.attempts,
      nextAttemptAt: outbox.nextAttemptAt ?? new Date(),
      publishedAt: null,
    });
    await em.persistAndFlush(record);
    return outbox;
  }

  /**
   * Múltiplos publishers concorrentes podem chamar este método sem duplicar publicações
   * graças ao FOR UPDATE SKIP LOCKED + lease temporário de 15 segundos em next_attempt_at.
   */
  async claimDueOutboxMessages(em: EntityManager, limit: number = 50): Promise<OutboxMessage[]> {
    const rows = await em.getConnection().execute(
      `WITH claimed AS (
         SELECT id
         FROM outbox_messages
         WHERE published_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY next_attempt_at ASC NULLS FIRST, occurred_at ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox_messages o
       SET next_attempt_at = NOW() + INTERVAL '15 seconds'
       FROM claimed
       WHERE o.id = claimed.id
       RETURNING o.*`,
      [limit],
    );

    return rows.map((r: any) =>
      OutboxMessage.rehydrate({
        id: r.id,
        aggregateId: r.aggregate_id,
        eventType: r.event_type,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
        occurredAt: new Date(r.occurred_at),
        attempts: Number(r.attempts),
        nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : undefined,
        publishedAt: r.published_at ? new Date(r.published_at) : undefined,
      }),
    );
  }

  async updateOutboxMessage(em: EntityManager, message: OutboxMessage): Promise<void> {
    await em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      },
    );
  }

  async getOldestUnpublishedOutboxLagMs(em: EntityManager): Promise<number> {
    const rows = await em.getConnection().execute(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))) * 1000 AS lag_ms
       FROM outbox_messages
       WHERE published_at IS NULL`,
    );
    const val = rows[0]?.lag_ms;
    return val ? Math.max(0, Math.round(Number(val))) : 0;
  }

  private toDomain(record: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind as WagerTransactionKind,
      money: Money.from({ amount: String(record.amount), currency: record.currency }),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      createdAt: new Date(record.createdAt),
      status: record.status as WagerTransactionStatus,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      failureCode: (record.failureCode as FailureCode) ?? undefined,
      processedAt: record.processedAt ? new Date(record.processedAt) : undefined,
      observedBalanceAfter: record.observedBalanceAfter
        ? Money.from({ amount: String(record.observedBalanceAfter), currency: record.currency })
        : undefined,
      retryCount: Number(record.retryCount ?? 0),
      nextRetryAt: record.nextRetryAt ? new Date(record.nextRetryAt) : undefined,
    });
  }

  private rawRowToDomain(row: any): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind as WagerTransactionKind,
      money: Money.from({ amount: String(row.amount), currency: row.currency }),
      referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
      createdAt: new Date(row.created_at),
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: row.reference_transaction_id ?? undefined,
      failureCode: (row.failure_code as FailureCode) ?? undefined,
      processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
      observedBalanceAfter: row.observed_balance_after
        ? Money.from({ amount: String(row.observed_balance_after), currency: row.currency })
        : undefined,
      retryCount: Number(row.retry_count ?? 0),
      nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at) : undefined,
    });
  }
}