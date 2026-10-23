import { DomainValidationError, FailureCode, InvalidTransactionStateError } from '../errors/domain.errors';
import { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry.entity';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
  allowOpening?: boolean;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalanceAfter?: Money;
  retryCount?: number;
  nextRetryAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalanceAfter?: Money,
    private _retryCount: number = 0,
    private _nextRetryAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening && !props.allowOpening) {
      throw new DomainValidationError('OPENING_NOT_ALLOWED', 'OPENING transaction kind is strictly internal');
    }

    if (
      (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) &&
      (!props.referenceExternalTransactionId || props.referenceExternalTransactionId.trim() === '')
    ) {
      throw new DomainValidationError(
        'REFERENCE_REQUIRED',
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }

    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new DomainValidationError(
        'INVALID_TRANSACTION_AMOUNT',
        `Transaction of kind ${props.kind} must have a positive amount`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalanceAfter,
      state.retryCount ?? 0,
      state.nextRetryAt,
    );
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }
  get observedBalanceAfter(): Money | undefined { return this._observedBalanceAfter; }
  get retryCount(): number { return this._retryCount; }
  get nextRetryAt(): Date | undefined { return this._nextRetryAt; }

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal('PROCESSED');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    if (observedBalance) {
      this._observedBalanceAfter = observedBalance;
    }
  }

  markPendingReference(now: Date = new Date()): void {
    this.assertNotTerminal('PENDING_REFERENCE');
    this._status = WagerTransactionStatus.PendingReference;
    this.scheduleNextReferenceCheck(now);
  }

  scheduleNextReferenceCheck(now: Date = new Date()): void {
    this.assertNotTerminal('PENDING_REFERENCE');
    this._retryCount += 1;
    const delayMs = Math.min(30_000, 500 * Math.pow(2, this._retryCount - 1));
    this._nextRetryAt = new Date(now.getTime() + delayMs);
  }

  reject(code: FailureCode, at: Date = new Date(), observedBalance?: Money): void {
    this.assertNotTerminal('REJECTED');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    if (observedBalance) {
      this._observedBalanceAfter = observedBalance;
    }
  }

  fail(code: FailureCode, at: Date = new Date()): void {
    this.assertNotTerminal('FAILED');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new DomainValidationError('MISSING_ROLLBACK_REFERENCE', 'Rollback requires a resolved reference transaction');
        }
        // Inverte o efeito da transação original (BET -> CREDIT, WIN -> DEBIT, REFUND -> DEBIT)
        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        }
        if (reference.kind === WagerTransactionKind.Win || reference.kind === WagerTransactionKind.Refund) {
          return LedgerDirection.Debit;
        }
        throw new DomainValidationError('INVALID_ROLLBACK_TARGET', `Cannot determine ledger direction for rollback of ${reference.kind}`);
      }
      case WagerTransactionKind.Loss:
        throw new DomainValidationError('LOSS_HAS_NO_LEDGER_DIRECTION', 'LOSS transactions do not affect balance or generate ledger entries');
    }
  }

  private assertNotTerminal(target: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, target);
    }
  }
}