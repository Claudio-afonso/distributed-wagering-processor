import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { WalletAlreadyExistsError } from '../../../domain/errors/domain.errors';
import { Money } from '../../../domain/shared/money';
import { LedgerDirection, WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.entity';
import { Wallet } from '../../../domain/wallet/wallet.aggregate';
import { WalletLedgerEntryRecord, WalletRecord } from '../entities/persistence.entities';

export interface LedgerPageResult {
  items: WalletLedgerEntry[];
  nextCursor: string | null;
}

export interface WalletReconciliationQueryResult {
  wallet: Wallet;
  calculatedBalance: Money;
  checkedEntries: number;
}

@Injectable()
export class WalletRepository {
  async insertWallet(em: EntityManager, wallet: Wallet): Promise<void> {
    try {
      const record = em.create(WalletRecord, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });
      await em.persistAndFlush(record);
    } catch (err: any) {
      if (err?.code === '23505' || err?.message?.includes('uq_wallets_player_currency')) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw err;
    }
  }

  async updateWallet(em: EntityManager, wallet: Wallet): Promise<void> {
    await em.nativeUpdate(
      WalletRecord,
      { id: wallet.id },
      {
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
  }

  async findById(em: EntityManager, walletId: string): Promise<Wallet | null> {
    const record = await em.findOne(WalletRecord, { id: walletId });
    return record ? this.toDomainWallet(record) : null;
  }

  /**
   * Unidade de concorrência = walletId (Seção 8).
   * Adquire row-level lock exclusivo no PostgreSQL (SELECT ... FOR UPDATE)
   * garantindo serialização apenas para esta wallet sem afetar outras wallets em paralelo.
   */
  async findByIdForUpdate(em: EntityManager, walletId: string): Promise<Wallet | null> {
    const record = await em.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? this.toDomainWallet(record) : null;
  }

  async insertLedgerEntry(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    const record = em.create(WalletLedgerEntryRecord, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    });
    await em.persistAndFlush(record);
  }

  async findLedgerPaginated(
    em: EntityManager,
    walletId: string,
    limit: number = 50,
    cursor?: string,
  ): Promise<LedgerPageResult> {
    const safeLimit = Math.min(Math.max(1, limit), 200);
    const conn = em.getConnection();

    let rows: any[];
    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        createdAt: string;
        id: string;
      };
      rows = await conn.execute(
        `SELECT * FROM wallet_ledger_entries
         WHERE wallet_id = ?
           AND (created_at, id) > (?::timestamptz, ?::uuid)
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
        [walletId, decoded.createdAt, decoded.id, safeLimit + 1],
      );
    } else {
      rows = await conn.execute(
        `SELECT * FROM wallet_ledger_entries
         WHERE wallet_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
        [walletId, safeLimit + 1],
      );
    }

    const hasMore = rows.length > safeLimit;
    const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;

    const items = pageRows.map((r) =>
      WalletLedgerEntry.rehydrate({
        id: r.id,
        walletId: r.wallet_id,
        transactionId: r.transaction_id,
        direction: r.direction as LedgerDirection,
        money: Money.from({ amount: String(r.amount), currency: r.currency }),
        balanceBefore: Money.from({ amount: String(r.balance_before), currency: r.currency }),
        balanceAfter: Money.from({ amount: String(r.balance_after), currency: r.currency }),
        createdAt: new Date(r.created_at),
      }),
    );

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
        'utf8',
      ).toString('base64url');
    }

    return { items, nextCursor };
  }

  async calculateReconciliation(
    em: EntityManager,
    walletId: string,
  ): Promise<WalletReconciliationQueryResult | null> {
    const wallet = await this.findById(em, walletId);
    if (!wallet) return null;

    const rows = await em.getConnection().execute(
      `SELECT
         COALESCE(
           SUM(
             CASE
               WHEN direction = 'CREDIT' THEN amount
               WHEN direction = 'DEBIT'  THEN -amount
             END
           ),
           0.00
         )::numeric(20,2) AS calculated_balance,
         COUNT(id)::int AS checked_entries
       FROM wallet_ledger_entries
       WHERE wallet_id = ?`,
      [walletId],
    );

    const row = rows[0];
    const calcAmount = row?.calculated_balance ? String(row.calculated_balance) : '0.00';

    return {
      wallet,
      calculatedBalance: Money.rehydrate(calcAmount, wallet.currency),
      checkedEntries: Number(row?.checked_entries ?? 0),
    };
  }

  private toDomainWallet(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: Money.from({ amount: String(record.balance), currency: record.currency }),
      version: Number(record.version),
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    });
  }
}