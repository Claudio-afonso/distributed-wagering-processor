import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { WalletNotFoundError } from '../../domain/errors/domain.errors';
import { MetricsService, StructuredLogger } from '../../infrastructure/observability/metrics.service';
import { WalletRepository } from '../../infrastructure/persistence/repositories/wallet.repository';

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly walletRepo: WalletRepository,
    private readonly metrics: MetricsService,
  ) {}

  async execute(walletId: string) {
    const result = await this.walletRepo.calculateReconciliation(this.em.fork(), walletId);
    if (!result) {
      throw new WalletNotFoundError(walletId);
    }

    const storedBalance = result.wallet.balance;
    const calculatedBalance = result.calculatedBalance;
    const difference = storedBalance.subtract(calculatedBalance);
    const consistent = difference.isZero();

    if (!consistent) {
      this.metrics.incrementReconciliationDivergence();
      StructuredLogger.error('wallet_reconciliation_divergence_detected', {
        walletId,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        checkedEntries: result.checkedEntries,
      });
    }

    return {
      walletId,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: result.checkedEntries,
    };
  }
}