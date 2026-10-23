import { EntitySchema } from '@mikro-orm/core';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', length: 3 },
    balance: { type: 'numeric', precision: 20, scale: 2 },
    version: { type: 'integer', default: 1 },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
    updatedAt: { type: 'Date', fieldName: 'updated_at', onCreate: () => new Date(), onUpdate: () => new Date() },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  observedBalanceAfter?: string | null;
  retryCount!: number;
  nextRetryAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', length: 100, fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', length: 150, fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', length: 255, fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', length: 64, fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', length: 150, fieldName: 'round_id' },
    gameId: { type: 'string', length: 150, fieldName: 'game_id' },
    kind: { type: 'string', length: 20 },
    amount: { type: 'numeric', precision: 20, scale: 2 },
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: { type: 'string', length: 150, fieldName: 'reference_external_transaction_id', nullable: true },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string', length: 30 },
    failureCode: { type: 'string', length: 80, fieldName: 'failure_code', nullable: true },
    observedBalanceAfter: { type: 'numeric', precision: 20, scale: 2, fieldName: 'observed_balance_after', nullable: true },
    retryCount: { type: 'integer', fieldName: 'retry_count', default: 0 },
    nextRetryAt: { type: 'Date', fieldName: 'next_retry_at', nullable: true },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
    processedAt: { type: 'Date', fieldName: 'processed_at', nullable: true },
  },
});

export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', length: 10 },
    amount: { type: 'numeric', precision: 20, scale: 2 },
    currency: { type: 'string', length: 3 },
    balanceBefore: { type: 'numeric', precision: 20, scale: 2, fieldName: 'balance_before' },
    balanceAfter: { type: 'numeric', precision: 20, scale: 2, fieldName: 'balance_after' },
    createdAt: { type: 'Date', fieldName: 'created_at', onCreate: () => new Date() },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', length: 100, fieldName: 'consumer_name', primary: true },
    messageId: { type: 'string', length: 150, fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', length: 64, fieldName: 'payload_hash' },
    receivedAt: { type: 'Date', fieldName: 'received_at', onCreate: () => new Date() },
    processedAt: { type: 'Date', fieldName: 'processed_at', nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', length: 100, fieldName: 'event_type' },
    payload: { type: 'json' },
    occurredAt: { type: 'Date', fieldName: 'occurred_at', onCreate: () => new Date() },
    attempts: { type: 'integer', default: 0 },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at', nullable: true },
    publishedAt: { type: 'Date', fieldName: 'published_at', nullable: true },
  },
});