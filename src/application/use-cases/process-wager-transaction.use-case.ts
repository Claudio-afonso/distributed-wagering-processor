import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  DomainValidationError,
  FailureCode,
  IdempotencyConflictError,
  InsufficientFundsError,
  WalletNotFoundError,
} from '../../domain/errors/domain.errors';
import { InboxMessage } from '../../domain/messaging/inbox-outbox.entities';
import { computeCanonicalPayloadHash } from '../../domain/shared/canonical-hash';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/shared/integration-event';
import { Money, MoneyProps } from '../../domain/shared/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.entity';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry.entity';
import { Wallet } from '../../domain/wallet/wallet.aggregate';
import { MetricsService, StructuredLogger } from '../../infrastructure/observability/metrics.service';
import { WagerTransactionRepository } from '../../infrastructure/persistence/repositories/wager-transaction.repository';
import { WalletRepository } from '../../infrastructure/persistence/repositories/wallet.repository';

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  inboxContext?: {
    consumerName: string;
    messageId: string;
  };
}

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

const MAX_PENDING_REFERENCE_RETRIES = 10;

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly walletRepo: WalletRepository,
    private readonly txRepo: WagerTransactionRepository,
    private readonly metrics: MetricsService,
  ) {}

  async execute(command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const startTime = Date.now();
    const correlationId = command.correlationId ?? uuidv4();

    if (!command.idempotencyKey || command.idempotencyKey.trim() === '') {
      throw new DomainValidationError('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key is required');
    }

    // Valida formato do Money e regras estáticas da transação antes de abrir transação no banco
    const money = Money.from(command.money);
    const payloadHash = computeCanonicalPayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
    });

    // Validação antecipada de regras de criação (ex: OPENING proibido, REFUND/ROLLBACK sem referência)
    WagerTransaction.create({
      id: uuidv4(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    try {
      const result = await this.em.transactional(async (txEm) => {
        // 1. Lock pessimista na Wallet (Unidade de concorrência = walletId).
        // Serializa todas as requisições simultâneas para esta wallet, garantindo que 50 requests
        // paralelos da mesma aposta não causem race condition nem violem constraints com erro 500.
        const wallet = await this.walletRepo.findByIdForUpdate(txEm, command.walletId);
        if (!wallet) {
          throw new WalletNotFoundError(command.walletId);
        }

        // 2. Se a entrada veio do SQS, verifica deduplicação da Inbox
        let inboxMsg: InboxMessage | undefined;
        if (command.inboxContext) {
          const existingInbox = await this.txRepo.findInboxMessage(
            txEm,
            command.inboxContext.consumerName,
            command.inboxContext.messageId,
          );
          if (existingInbox && existingInbox.isProcessed()) {
            this.metrics.incrementDuplicateDetected('sqs_inbox');
            const existingTxByKey = await this.txRepo.findByIdempotencyKey(txEm, command.idempotencyKey);
            if (existingTxByKey) {
              return this.buildReplayResponse(existingTxByKey, wallet);
            }
          }
          inboxMsg = InboxMessage.receive({
            consumerName: command.inboxContext.consumerName,
            messageId: command.inboxContext.messageId,
            payloadHash,
          });
        }

        // 3. Verifica Idempotência por Idempotency-Key ou (providerId, externalTransactionId)
        const existingTx =
          (await this.txRepo.findByIdempotencyKey(txEm, command.idempotencyKey)) ??
          (await this.txRepo.findByProviderAndExternalId(
            txEm,
            command.providerId,
            command.externalTransactionId,
          ));

        if (existingTx) {
          if (
            existingTx.idempotencyKey !== command.idempotencyKey ||
            !existingTx.matchesPayload(payloadHash)
          ) {
            this.metrics.incrementIdempotencyConflict();
            throw new IdempotencyConflictError(command.idempotencyKey);
          }

          this.metrics.incrementDuplicateDetected('http_idempotency');
          if (inboxMsg) {
            inboxMsg.markProcessed(new Date());
            await this.txRepo.saveInboxMessage(txEm, inboxMsg);
          }
          return this.buildReplayResponse(existingTx, wallet);
        }

        // 4. Cria a nova WagerTransaction em PENDING
        const now = new Date();
        const tx = WagerTransaction.create({
          id: uuidv4(),
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: command.idempotencyKey,
          payloadHash,
          walletId: command.walletId,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money,
          referenceExternalTransactionId: command.referenceExternalTransactionId,
          createdAt: now,
        });

        // 5. Aplica as regras de domínio e persiste tudo atomicamente
        const executionResult = await this.applyDomainRulesAndPersist(
          txEm,
          wallet,
          tx,
          correlationId,
          now,
        );

        if (inboxMsg) {
          inboxMsg.markProcessed(now);
          await this.txRepo.saveInboxMessage(txEm, inboxMsg);
        }

        return executionResult;
      });

      this.metrics.recordProcessingLatencyMs(command.kind, Date.now() - startTime);
      StructuredLogger.info('wager_transaction_handled', {
        correlationId,
        messageId: command.inboxContext?.messageId,
        transactionId: result.transactionId,
        walletId: command.walletId,
        providerId: command.providerId,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
        durationMs: Date.now() - startTime,
      });

      return result;
    } catch (err: any) {
      if (err?.code === '40P01' || err?.code === '55P03') {
        this.metrics.incrementLockConflict();
      }
      throw err;
    }
  }

  /**
   * Reprocessa transações em PENDING_REFERENCE (Seção 7.1) via Worker agendado
   */
  async retryPendingReferencesBatch(): Promise<number> {
    return await this.em.transactional(async (txEm) => {
      const pendingTxs = await this.txRepo.claimDuePendingReferenceTransactions(txEm, 25);
      let processedCount = 0;

      for (const tx of pendingTxs) {
        const wallet = await this.walletRepo.findByIdForUpdate(txEm, tx.walletId);
        if (!wallet) continue;

        const now = new Date();
        const correlationId = uuidv4();

        const refTx = await this.txRepo.findByProviderAndExternalId(
          txEm,
          tx.providerId,
          tx.referenceExternalTransactionId!,
        );

        if (
          !refTx ||
          refTx.status === WagerTransactionStatus.Pending ||
          refTx.status === WagerTransactionStatus.PendingReference
        ) {
          this.metrics.incrementRetry('pending_reference');
          if (tx.retryCount >= MAX_PENDING_REFERENCE_RETRIES) {
            await this.rejectTransaction(
              txEm,
              wallet,
              tx,
              FailureCode.ReferenceNotFoundTimeout,
              correlationId,
              now,
            );
          } else {
            tx.scheduleNextReferenceCheck(now);
            await this.txRepo.save(txEm, tx);
          }
          processedCount += 1;
          continue;
        }

        await this.applyDomainRulesAndPersist(txEm, wallet, tx, correlationId, now);
        processedCount += 1;
      }

      return processedCount;
    });
  }

  private async applyDomainRulesAndPersist(
    txEm: EntityManager,
    wallet: Wallet,
    tx: WagerTransaction,
    correlationId: string,
    now: Date,
  ): Promise<SubmitWagerResult> {
    // Regra de contexto: Player e Moeda da Wallet
    if (wallet.playerId !== tx.playerId) {
      return await this.rejectTransaction(
        txEm,
        wallet,
        tx,
        FailureCode.PlayerWalletMismatch,
        correlationId,
        now,
      );
    }

    if (wallet.currency !== tx.money.currency) {
      return await this.rejectTransaction(
        txEm,
        wallet,
        tx,
        FailureCode.CurrencyMismatch,
        correlationId,
        now,
      );
    }

    // Resolução de Referência (REFUND, ROLLBACK ou WIN referenciando BET)
    let referenceTx: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId) {
      referenceTx =
        (await this.txRepo.findByProviderAndExternalId(
          txEm,
          tx.providerId,
          tx.referenceExternalTransactionId,
        )) ?? undefined;

      if (
        !referenceTx ||
        referenceTx.status === WagerTransactionStatus.Pending ||
        referenceTx.status === WagerTransactionStatus.PendingReference
      ) {
        if (tx.requiresReference()) {
          tx.markPendingReference(now);
          await this.txRepo.save(txEm, tx);
          await this.txRepo.enqueueOutboxEvent(
            txEm,
            WagerTransactionPendingReference.from(tx, {
              eventId: uuidv4(),
              correlationId,
              occurredAt: now,
            }),
          );
          this.metrics.incrementTransactionStatus(tx.status, tx.kind);
          return {
            transactionId: tx.id,
            status: tx.status,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
          };
        }
      } else {
        const refValidationFailure = await this.validateReference(txEm, tx, referenceTx);
        if (refValidationFailure) {
          return await this.rejectTransaction(
            txEm,
            wallet,
            tx,
            refValidationFailure,
            correlationId,
            now,
          );
        }
      }
    }

    // Aplicação de Saldo e Geração do Lançamento no Ledger
    try {
      let ledgerEntry;
      if (tx.affectsBalance()) {
        const direction = tx.ledgerDirectionFor(referenceTx);
        const isReversal =
          tx.kind === WagerTransactionKind.Refund || tx.kind === WagerTransactionKind.Rollback;

        ledgerEntry =
          direction === LedgerDirection.Debit
            ? wallet.debit({
                entryId: uuidv4(),
                transactionId: tx.id,
                amount: tx.money,
                at: now,
                isReversal,
              })
            : wallet.credit({
                entryId: uuidv4(),
                transactionId: tx.id,
                amount: tx.money,
                at: now,
              });
      }

      tx.markProcessed(referenceTx?.id, now, wallet.balance);

      if (ledgerEntry) {
        await this.walletRepo.updateWallet(txEm, wallet);
      }
      await this.txRepo.save(txEm, tx);

      if (ledgerEntry) {
        await this.walletRepo.insertLedgerEntry(txEm, ledgerEntry);
        await this.txRepo.enqueueOutboxEvent(
          txEm,
          WalletBalanceChanged.from(wallet, ledgerEntry, {
            eventId: uuidv4(),
            correlationId,
            occurredAt: now,
          }),
        );
      }

      await this.txRepo.enqueueOutboxEvent(
        txEm,
        WagerTransactionProcessed.from(tx, wallet.balance, {
          eventId: uuidv4(),
          correlationId,
          occurredAt: now,
        }),
      );

      this.metrics.incrementTransactionStatus(tx.status, tx.kind);

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        return await this.rejectTransaction(txEm, wallet, tx, err.code, correlationId, now);
      }
      throw err;
    }
  }

  private async validateReference(
    txEm: EntityManager,
    tx: WagerTransaction,
    ref: WagerTransaction,
  ): Promise<FailureCode | null> {
    // Regra 7.2: mesmo provider, player, wallet, moeda e rodada
    if (
      ref.providerId !== tx.providerId ||
      ref.playerId !== tx.playerId ||
      ref.walletId !== tx.walletId ||
      ref.money.currency !== tx.money.currency ||
      ref.roundId !== tx.roundId
    ) {
      return FailureCode.ReferenceContextMismatch;
    }

    // A transação referenciada precisa ter sido PROCESSED
    if (ref.status !== WagerTransactionStatus.Processed) {
      return FailureCode.InvalidReferenceTarget;
    }

    if (tx.kind === WagerTransactionKind.Win) {
      if (ref.kind !== WagerTransactionKind.Bet) {
        return FailureCode.InvalidReferenceTarget;
      }
      return null;
    }

    // Regra 7.3: REFUND só referencia BET. ROLLBACK referencia BET, WIN ou REFUND.
    if (tx.kind === WagerTransactionKind.Refund && ref.kind !== WagerTransactionKind.Bet) {
      return FailureCode.InvalidReferenceTarget;
    }

    if (
      tx.kind === WagerTransactionKind.Rollback &&
      ref.kind !== WagerTransactionKind.Bet &&
      ref.kind !== WagerTransactionKind.Win &&
      ref.kind !== WagerTransactionKind.Refund
    ) {
      return FailureCode.InvalidReferenceTarget;
    }

    // Regra 7.5: O valor de REFUND/ROLLBACK deve ser igual ao valor da referência
    if (!tx.money.equals(ref.money)) {
      return FailureCode.ReferenceContextMismatch;
    }

    // Regra 7.4: Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação
    if (
      tx.kind === WagerTransactionKind.Refund ||
      tx.kind === WagerTransactionKind.Rollback
    ) {
      const alreadyReversed = await this.txRepo.hasProcessedReversalOfKind(txEm, ref.id, tx.kind);
      if (alreadyReversed) {
        return FailureCode.ReferenceAlreadyReversed;
      }
    }

    return null;
  }

  private async rejectTransaction(
    txEm: EntityManager,
    wallet: Wallet,
    tx: WagerTransaction,
    code: FailureCode,
    correlationId: string,
    now: Date,
  ): Promise<SubmitWagerResult> {
    tx.reject(code, now, wallet.balance);
    await this.txRepo.save(txEm, tx);
    await this.txRepo.enqueueOutboxEvent(
      txEm,
      WagerTransactionRejected.from(tx, {
        eventId: uuidv4(),
        correlationId,
        occurredAt: now,
      }),
    );

    this.metrics.incrementTransactionStatus(tx.status, tx.kind);

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      failureCode: code,
      idempotentReplay: false,
    };
  }

  private buildReplayResponse(existingTx: WagerTransaction, wallet: Wallet): SubmitWagerResult {
    const observedBalance = existingTx.observedBalanceAfter ?? wallet.balance;
    return {
      transactionId: existingTx.id,
      status: existingTx.status,
      balance: observedBalance.toJSON(),
      ...(existingTx.failureCode ? { failureCode: existingTx.failureCode } : {}),
      idempotentReplay: true,
    };
  }
}