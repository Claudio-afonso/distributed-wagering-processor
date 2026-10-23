import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from './entities/persistence.entities';
import { Migration20260729000000_InitialSchema } from './migrations/Migration20260729000000_InitialSchema';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/jungle_wagering',
  entities: [
    WalletSchema,
    WagerTransactionSchema,
    WalletLedgerEntrySchema,
    InboxMessageSchema,
    OutboxMessageSchema,
  ],
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      {
        name: 'Migration20260729000000_InitialSchema',
        class: Migration20260729000000_InitialSchema,
      },
    ],
  },
  allowGlobalContext: true,
});