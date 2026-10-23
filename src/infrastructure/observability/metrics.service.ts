import { Injectable } from '@nestjs/common';

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();
  private outboxLagMs = 0;

  incrementTransactionStatus(status: string, kind: string): void {
    this.inc(`wager_transactions_total{status="${status}",kind="${kind}"}`);
  }

  incrementDuplicateDetected(source: 'http_idempotency' | 'sqs_inbox'): void {
    this.inc(`wager_duplicates_detected_total{source="${source}"}`);
  }

  incrementIdempotencyConflict(): void {
    this.inc('wager_idempotency_conflicts_total');
  }

  incrementRetry(worker: 'sqs' | 'outbox' | 'pending_reference'): void {
    this.inc(`wager_retries_total{worker="${worker}"}`);
  }

  incrementDlqMessages(): void {
    this.inc('wager_dlq_messages_total');
  }

  incrementLockConflict(): void {
    this.inc('wallet_lock_conflicts_total');
  }

  incrementReconciliationDivergence(): void {
    this.inc('wallet_reconciliation_divergence_total');
  }

  setOutboxLagMs(lagMs: number): void {
    this.outboxLagMs = Math.max(0, lagMs);
  }

  recordProcessingLatencyMs(operation: string, durationMs: number): void {
    const key = `wager_processing_latency_ms{operation="${operation}"}`;
    const list = this.histograms.get(key) ?? [];
    list.push(durationMs);
    this.histograms.set(key, list);
  }

  getSnapshot(): Record<string, unknown> {
    const countersObj: Record<string, number> = {};
    for (const [k, v] of this.counters.entries()) {
      countersObj[k] = v;
    }

    const latencySummary: Record<string, { count: number; avgMs: number; maxMs: number }> = {};
    for (const [k, values] of this.histograms.entries()) {
      const sum = values.reduce((a, b) => a + b, 0);
      latencySummary[k] = {
        count: values.length,
        avgMs: values.length ? Number((sum / values.length).toFixed(2)) : 0,
        maxMs: values.length ? Math.max(...values) : 0,
      };
    }

    return {
      counters: countersObj,
      outboxLagMs: this.outboxLagMs,
      latency: latencySummary,
    };
  }

  private inc(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
}

export class StructuredLogger {
  static info(event: string, context: {
    correlationId?: string;
    messageId?: string;
    transactionId?: string;
    walletId?: string;
    providerId?: string;
    status?: string;
    failureCode?: string;
    durationMs?: number;
    [key: string]: unknown;
  }): void {
    console.log(
      JSON.stringify({
        level: 'info',
        timestamp: new Date().toISOString(),
        event,
        ...context,
      }),
    );
  }

  static warn(event: string, context: Record<string, unknown>): void {
    console.warn(
      JSON.stringify({
        level: 'warn',
        timestamp: new Date().toISOString(),
        event,
        ...context,
      }),
    );
  }

  static error(event: string, context: Record<string, unknown>): void {
    console.error(
      JSON.stringify({
        level: 'error',
        timestamp: new Date().toISOString(),
        event,
        ...context,
      }),
    );
  }
}