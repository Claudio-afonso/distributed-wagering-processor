import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { computeCanonicalPayloadHash } from '../../domain/shared/canonical-hash';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/shared/integration-event';
import { Money, MoneyProps } from '../../domain/shared/money';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wagering/wager-transaction.entity';
import { Wallet } from '../../domain/wallet/wallet.aggregate';
import { WagerTransactionRepository } from '../../infrastructure/persistence/repositories/wager-transaction.repository';
import { WalletRepository } from '../../infrastructure/persistence/repositories/wallet.repository';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

@Injectable()
export class OpenWalletUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly walletRepo: WalletRepository,
    private readonly txRepo: WagerTransactionRepository,
  ) {}

  async execute(command: OpenWalletCommand) {
    const initialMoney = Money.from(command.initialBalance);
    const walletId = uuidv4();
    const openingTxId = uuidv4();
    const openingEntryId = uuidv4();
    const now = new Date();
    const correlationId = command.correlationId ?? uuidv4();

    return await this.em.transactional(async (txEm) => {
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance: initialMoney,
        openingTransactionId: openingTxId,
        openingEntryId,
        now,
      });

      await this.walletRepo.insertWallet(txEm, wallet);

      if (openingEntry) {
        const payloadHash = computeCanonicalPayloadHash({
          providerId: 'INTERNAL_SYSTEM',
          externalTransactionId: `opening:${wallet.id}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `opening:${wallet.id}`,
          gameId: 'WALLET_OPENING',
          kind: WagerTransactionKind.Opening,
          money: initialMoney.toJSON(),
        });

        const openingTx = WagerTransaction.create({
          id: openingTxId,
          providerId: 'INTERNAL_SYSTEM',
          externalTransactionId: `opening:${wallet.id}`,
          idempotencyKey: `INTERNAL_SYSTEM:opening:${wallet.id}`,
          payloadHash,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: `opening:${wallet.id}`,
          gameId: 'WALLET_OPENING',
          kind: WagerTransactionKind.Opening,
          money: initialMoney,
          createdAt: now,
          allowOpening: true,
        });

        openingTx.markProcessed(undefined, now, wallet.balance);

        await this.txRepo.save(txEm, openingTx);
        await this.walletRepo.insertLedgerEntry(txEm, openingEntry);

        await this.txRepo.enqueueOutboxEvent(
          txEm,
          WalletBalanceChanged.from(wallet, openingEntry, {
            eventId: uuidv4(),
            correlationId,
            occurredAt: now,
          }),
        );
        await this.txRepo.enqueueOutboxEvent(
          txEm,
          WagerTransactionProcessed.from(openingTx, wallet.balance, {
            eventId: uuidv4(),
            correlationId,
            occurredAt: now,
          }),
        );
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}