import Decimal from 'decimal.js';
import { CurrencyMismatchError, DomainValidationError } from '../errors/domain.errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const STRICT_DECIMAL_REGEX = /^\d+\.\d{2}$/;
const ISO_CURRENCY_REGEX = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string' || typeof props.currency !== 'string') {
      throw new DomainValidationError('INVALID_MONEY_FORMAT', 'Amount and currency must be strings');
    }
    if (!ISO_CURRENCY_REGEX.test(props.currency)) {
      throw new DomainValidationError('INVALID_CURRENCY', `Invalid ISO-4217 currency: "${props.currency}"`);
    }
    if (!STRICT_DECIMAL_REGEX.test(props.amount)) {
      throw new DomainValidationError(
        'INVALID_AMOUNT_FORMAT',
        `Amount must be a non-negative decimal string with fixed scale of 2 (e.g. "25.00"). Received: "${props.amount}"`,
      );
    }

    return new Money(new Decimal(props.amount), props.currency);
  }

  /** Reidratação ou resultados aritméticos internos que podem ser negativos (ex: negate ou diferença na reconciliação) */
  static rehydrate(amount: string, currency: string): Money {
    return new Money(new Decimal(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}