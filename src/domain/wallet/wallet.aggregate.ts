import { CurrencyMismatchError, DomainValidationError, FailureCode, InsufficientFundsError } from '../errors/domain.errors';
import { Money } from '../shared/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.entity';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletResult {
  wallet: Wallet;
  openingEntry?: WalletLedgerEntry;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingEntryId?: string;
    openingTransactionId?: string;
    now?: Date;
  }): OpenWalletResult {
    if (props.initialBalance.isNegative()) {
      throw new DomainValidationError('NEGATIVE_INITIAL_BALANCE', 'Initial balance cannot be negative');
    }

    const now = props.now ?? new Date();
    const zero = Money.zero(props.initialBalance.currency);

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      zero,
      1,
      now,
      now,
    );

    let openingEntry: WalletLedgerEntry | undefined;

    if (props.initialBalance.isPositive()) {
      if (!props.openingEntryId || !props.openingTransactionId) {
        throw new DomainValidationError(
          'MISSING_OPENING_IDS',
          'openingEntryId and openingTransactionId are required when initialBalance > 0',
        );
      }
      openingEntry = WalletLedgerEntry.create({
        id: props.openingEntryId,
        walletId: wallet.id,
        transactionId: props.openingTransactionId,
        direction: LedgerDirection.Credit,
        money: props.initialBalance,
        balanceBefore: zero,
        balanceAfter: props.initialBalance,
        createdAt: now,
      });
      wallet._balance = props.initialBalance;
      // version permanece 1 após a criação conforme invariante da Seção 6.2
    }

    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(params: {
    entryId: string;
    transactionId: string;
    amount: Money;
    at: Date;
    isReversal?: boolean;
  }): WalletLedgerEntry {
    this.assertSameCurrency(params.amount);

    if (this._balance.isLessThan(params.amount)) {
      const code = params.isReversal
        ? FailureCode.ReversalWouldCauseNegativeBalance
        : FailureCode.InsufficientFunds;
      throw new InsufficientFundsError(
        code,
        `Insufficient balance (${this._balance.toString()}) for debit of ${params.amount.toString()}`,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(params.amount);

    const entry = WalletLedgerEntry.create({
      id: params.entryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Debit,
      money: params.amount,
      balanceBefore,
      balanceAfter,
      createdAt: params.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = params.at;

    return entry;
  }

  credit(params: {
    entryId: string;
    transactionId: string;
    amount: Money;
    at: Date;
  }): WalletLedgerEntry {
    this.assertSameCurrency(params.amount);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(params.amount);

    const entry = WalletLedgerEntry.create({
      id: params.entryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Credit,
      money: params.amount,
      balanceBefore,
      balanceAfter,
      createdAt: params.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = params.at;

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}