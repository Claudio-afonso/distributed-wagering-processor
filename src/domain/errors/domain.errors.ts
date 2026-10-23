export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldCauseNegativeBalance = 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  InvalidReferenceTarget = 'INVALID_REFERENCE_TARGET',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReferenceNotFoundTimeout = 'REFERENCE_NOT_FOUND_TIMEOUT',
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}

export class DomainValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

export class CurrencyMismatchError extends DomainValidationError {
  constructor(expected: string, actual: string) {
    super('CURRENCY_MISMATCH', `Currency mismatch: expected ${expected}, got ${actual}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InsufficientFundsError extends Error {
  constructor(
    public readonly code: FailureCode.InsufficientFunds | FailureCode.ReversalWouldCauseNegativeBalance,
    message: string,
  ) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(currentStatus: string, attemptedTransition: string) {
    super(`Cannot transition transaction from terminal/current status ${currentStatus} to ${attemptedTransition}`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used with a different payload`);
    this.name = 'IdempotencyConflictError';
  }
}

export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player ${playerId} and currency ${currency}`);
    this.name = 'WalletAlreadyExistsError';
  }
}

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
    this.name = 'WalletNotFoundError';
  }
}