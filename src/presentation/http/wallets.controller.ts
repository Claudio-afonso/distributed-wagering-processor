import { EntityManager } from '@mikro-orm/postgresql';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { OpenWalletUseCase } from '../../application/use-cases/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet.use-case';
import { DomainValidationError, WalletNotFoundError } from '../../domain/errors/domain.errors';
import { MoneyProps } from '../../domain/shared/money';
import { WalletRepository } from '../../infrastructure/persistence/repositories/wallet.repository';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly em: EntityManager,
    private readonly openWalletUseCase: OpenWalletUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
    private readonly walletRepo: WalletRepository,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWallet(
    @Body() body: { playerId: string; initialBalance: MoneyProps },
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!body?.playerId || typeof body.playerId !== 'string') {
      throw new DomainValidationError('INVALID_PLAYER_ID', 'playerId is required');
    }
    return await this.openWalletUseCase.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId,
    });
  }

  @Get(':walletId')
  async getWallet(@Param('walletId') walletId: string) {
    const wallet = await this.walletRepo.findById(this.em.fork(), walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  @Get(':walletId/ledger')
  async getWalletLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitStr?: string,
  ) {
    const emFork = this.em.fork();
    const wallet = await this.walletRepo.findById(emFork, walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    const limit = limitStr ? Number.parseInt(limitStr, 10) : 50;
    const page = await this.walletRepo.findLedgerPaginated(emFork, walletId, limit, cursor);

    return {
      walletId,
      items: page.items.map((entry) => ({
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcileWallet(@Param('walletId') walletId: string) {
    return await this.reconcileWalletUseCase.execute(walletId);
  }
}