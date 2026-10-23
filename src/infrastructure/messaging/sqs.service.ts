import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { StructuredLogger } from '../observability/metrics.service';

@Injectable()
export class SqsService implements OnModuleInit {
  public readonly client: SQSClient;
  public wagerQueueUrl!: string;
  public wagerDlqUrl!: string;
  public integrationEventsQueueUrl!: string;

  constructor() {
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  async onModuleInit(): Promise<void> {
    if (process.env.DISABLE_SQS_INIT === 'true') return;
    await this.ensureQueuesExist();
  }

  async ensureQueuesExist(): Promise<void> {
    try {
      this.wagerDlqUrl = await this.getOrCreateFifoQueue('wager-transactions-dlq.fifo');
      this.wagerQueueUrl = await this.getOrCreateFifoQueue('wager-transactions.fifo');
      this.integrationEventsQueueUrl = await this.getOrCreateFifoQueue('wager-integration-events.fifo');
    } catch (err) {
      StructuredLogger.warn('sqs_ensure_queues_failed', {
        error: (err as Error)?.message,
      });
    }
  }

  private async getOrCreateFifoQueue(queueName: string): Promise<string> {
    try {
      const existing = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
      if (existing.QueueUrl) return existing.QueueUrl;
    } catch {
      // Fila ainda não existe, cria abaixo
    }

    const created = await this.client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '30',
        },
      }),
    );

    return created.QueueUrl!;
  }

  async isReachable(): Promise<boolean> {
    try {
      if (!this.wagerQueueUrl) {
        await this.ensureQueuesExist();
      }
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.wagerQueueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async receiveWagerMessages(maxMessages: number = 10, waitTimeSeconds: number = 1): Promise<Message[]> {
    if (!this.wagerQueueUrl) await this.ensureQueuesExist();
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.wagerQueueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    return res.Messages ?? [];
  }

  async ackMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async releaseVisibility(queueUrl: string, receiptHandle: string, visibilityTimeoutSeconds: number = 0): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeoutSeconds,
      }),
    );
  }

  async sendToDlq(rawBody: string, reason: string, messageGroupId: string = 'dlq-group'): Promise<void> {
    if (!this.wagerDlqUrl) await this.ensureQueuesExist();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.wagerDlqUrl,
        MessageBody: rawBody,
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: uuidv4(),
        MessageAttributes: {
          DlqReason: {
            DataType: 'String',
            StringValue: reason,
          },
        },
      }),
    );
  }

  async publishIntegrationEvent(
    aggregateId: string,
    eventId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.integrationEventsQueueUrl) await this.ensureQueuesExist();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.integrationEventsQueueUrl,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: aggregateId,
        MessageDeduplicationId: eventId,
      }),
    );
  }

  async enqueueWagerTransactionMessage(envelope: {
    messageId: string;
    type: 'WagerTransactionRequested';
    occurredAt: string;
    data: {
      providerId: string;
      externalTransactionId: string;
      idempotencyKey: string;
      playerId: string;
      walletId: string;
      roundId: string;
      gameId: string;
      kind: string;
      money: { amount: string; currency: string };
      referenceExternalTransactionId?: string;
    };
  }): Promise<void> {
    if (!this.wagerQueueUrl) await this.ensureQueuesExist();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.wagerQueueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: envelope.data.walletId,
        // Usa uuid na deduplicação do broker nos testes para permitir testar redelivery na aplicação (Seção 5.3 e 8)
        MessageDeduplicationId: `${envelope.messageId}-${uuidv4()}`,
      }),
    );
  }
}