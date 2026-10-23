import { Migration } from '@mikro-orm/migrations';

export class Migration20260729000000_InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0.00),
        CONSTRAINT chk_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT chk_wallets_currency_len CHECK (char_length(currency) = 3)
      );

      CREATE TABLE IF NOT EXISTS wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(100) NOT NULL,
        external_transaction_id VARCHAR(150) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        player_id UUID NOT NULL,
        round_id VARCHAR(150) NOT NULL,
        game_id VARCHAR(150) NOT NULL,
        kind VARCHAR(20) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(150),
        reference_transaction_id UUID REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        status VARCHAR(30) NOT NULL,
        failure_code VARCHAR(80),
        observed_balance_after NUMERIC(20, 2),
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,

        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT chk_wager_tx_amount_non_negative CHECK (amount >= 0.00),
        CONSTRAINT chk_wager_tx_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT chk_wager_tx_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT chk_wager_tx_ref_required CHECK (
          (kind IN ('REFUND', 'ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
          OR (kind NOT IN ('REFUND', 'ROLLBACK'))
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_wager_tx_single_reversal
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');

      CREATE INDEX IF NOT EXISTS idx_wager_tx_pending_ref
        ON wager_transactions (next_retry_at ASC)
        WHERE status = 'PENDING_REFERENCE';

      CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
        transaction_id UUID NOT NULL REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        direction VARCHAR(10) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_before NUMERIC(20, 2) NOT NULL,
        balance_after NUMERIC(20, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT uq_ledger_tx_wallet UNIQUE (wallet_id, transaction_id),
        CONSTRAINT chk_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0.00),
        CONSTRAINT chk_ledger_balance_non_negative CHECK (balance_before >= 0.00 AND balance_after >= 0.00),
        CONSTRAINT chk_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_before + amount = balance_after) OR
          (direction = 'DEBIT'  AND balance_before - amount = balance_after)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_wallet_cursor
        ON wallet_ledger_entries (wallet_id, created_at ASC, id ASC);

      CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Wallet ledger entries are strictly immutable (UPDATE and DELETE are forbidden)';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_immutable_ledger ON wallet_ledger_entries;
      CREATE TRIGGER trg_immutable_ledger
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

      CREATE TABLE IF NOT EXISTS inbox_messages (
        consumer_name VARCHAR(100) NOT NULL,
        message_id VARCHAR(150) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id)
      );

      CREATE TABLE IF NOT EXISTS outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
        ON outbox_messages (next_attempt_at ASC)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_immutable_ledger ON wallet_ledger_entries;
      DROP FUNCTION IF EXISTS prevent_ledger_mutation();
      DROP TABLE IF EXISTS outbox_messages;
      DROP TABLE IF EXISTS inbox_messages;
      DROP TABLE IF EXISTS wallet_ledger_entries;
      DROP TABLE IF EXISTS wager_transactions;
      DROP TABLE IF EXISTS wallets;
    `);
  }
}