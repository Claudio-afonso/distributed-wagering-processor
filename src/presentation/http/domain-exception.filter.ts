import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  DomainValidationError,
  IdempotencyConflictError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../domain/errors/domain.errors';
import { StructuredLogger } from '../../infrastructure/observability/metrics.service';

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof DomainValidationError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        error: 'INVALID_PAYLOAD',
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof WalletNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({
        error: 'NOT_FOUND',
        code: 'WALLET_NOT_FOUND',
        message: exception.message,
      });
      return;
    }

    if (exception instanceof WalletAlreadyExistsError) {
      response.status(HttpStatus.CONFLICT).json({
        error: 'CONFLICT',
        code: 'WALLET_ALREADY_EXISTS',
        message: exception.message,
      });
      return;
    }

    if (exception instanceof IdempotencyConflictError) {
      response.status(HttpStatus.CONFLICT).json({
        error: 'IDEMPOTENCY_CONFLICT',
        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        message: exception.message,
      });
      return;
    }

    const pgCode = (exception as any)?.code;
    if (pgCode === '40P01' || pgCode === '55P03' || pgCode === 'ECONNREFUSED' || pgCode === '57P01') {
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: 'TRANSIENT_INFRASTRUCTURE_ERROR',
        code: 'INFRASTRUCTURE_UNAVAILABLE',
        message: 'Database temporarily unavailable or lock timeout exceeded. Safe to retry.',
      });
      return;
    }

    StructuredLogger.error('unhandled_http_exception', {
      path: request?.url,
      errorName: (exception as Error)?.name,
      errorMessage: (exception as Error)?.message,
    });

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: 'INTERNAL_SERVER_ERROR',
      code: 'UNEXPECTED_ERROR',
      message: 'An unexpected error occurred',
    });
  }
}