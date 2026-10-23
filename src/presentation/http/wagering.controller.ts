import { EntityManager } from '@mikro-orm/postgresql';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { DomainValidationError } from '../../domain/errors/domain.errors';
import { MoneyProps } from '../../domain/shared/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.entity';
import { WagerTransactionRepository } from '../../infrastructure/persistence/repositories/wager-transaction.repository';

@Controller()
export class WageringController {
  constructor(
    private readonly em: EntityManager,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly txRepo: WagerTransactionRepository,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body()
    body: {
      providerId: string;
      externalTransactionId: string;
      playerId: string;
      walletId: string;
      roundId: string;
      gameId: string;
      kind: WagerTransactionKind;
      money: MoneyProps;
      referenceExternalTransactionId?: string;
    },
    @Res() res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new DomainValidationError('MISSING_IDEMPOTENCY_KEY', 'Header Idempotency-Key is mandatory');
    }

    if (
      !body ||
      !body.providerId ||
      !body.externalTransactionId ||
      !body.playerId ||
      !body.walletId ||
      !body.roundId ||
      !body.gameId ||
      !body.kind ||
      !body.money
    ) {
      throw new DomainValidationError('MISSING_REQUIRED_FIELDS', 'Missing required transaction fields in payload');
    }

    const result = await this.processWagerUseCase.execute({
      idempotencyKey: idempotencyKey.trim(),
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      correlationId,
    });

    // Mapeamento consistente de Status HTTP (Seção 9):
    // - PROCESSED -> 200 OK
    // - PENDING_REFERENCE -> 202 Accepted
    // - REJECTED (regra de negócio) -> 422 Unprocessable Entity
    let httpStatus = HttpStatus.OK;
    if (result.status === WagerTransactionStatus.PendingReference) {
      httpStatus = HttpStatus.ACCEPTED;
    } else if (result.status === WagerTransactionStatus.Rejected) {
      httpStatus = HttpStatus.UNPROCESSABLE_ENTITY;
    }

    res.status(httpStatus).json(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getByTransactionId(@Param('transactionId') transactionId: string) {
    const tx = await this.txRepo.findById(this.em.fork(), transactionId);
    if (!tx) {
      throw new NotFoundException({
        error: 'NOT_FOUND',
        code: 'TRANSACTION_NOT_FOUND',
        message: `Transaction ${transactionId} not found`,
      });
    }
    return this.serializeTransaction(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const tx = await this.txRepo.findByProviderAndExternalId(
      this.em.fork(),
      providerId,
      externalTransactionId,
    );
    if (!tx) {
      throw new NotFoundException({
        error: 'NOT_FOUND',
        code: 'TRANSACTION_NOT_FOUND',
        message: `Transaction ${providerId}:${externalTransactionId} not found`,
      });
    }
    return this.serializeTransaction(tx);
  }

  private serializeTransaction(tx: WagerTransaction) {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      status: tx.status,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null,
      observedBalanceAfter: tx.observedBalanceAfter ? tx.observedBalanceAfter.toJSON() : null,
      createdAt: tx.createdAt.toISOString(),
      processedAt: tx.processedAt ? tx.processedAt.toISOString() : null,
    };
  }
}