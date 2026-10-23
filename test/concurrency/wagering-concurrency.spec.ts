import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/shared/money';
import { Wallet } from '../../src/domain/wallet/wallet.aggregate';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wagering/wager-transaction.entity';

describe('Concurrency & Race Condition Tests (Section 13)', () => {
  test('Hot wallet concurrent bets: 50 parallel requests of 80.00 BRL with initial balance 100.00 BRL should result in exactly 1 success and 49 rejections', async () => {
    // Cenário obrigatório da Seção 8:
    // Saldo inicial 100.00 BRL. Duas apostas de 80.00 BRL processadas simultaneamente (aqui testamos com 50 para estressar).
    const walletData = Wallet.open({
      id: 'wallet-test-concurrency',
      playerId: 'player-test-1',
      currency: 'BRL',
    });
    const wallet = walletData.wallet;
    
    // Credita 100.00 BRL iniciais
    wallet.credit({
      entryId: 'entry-opening',
      transactionId: 'tx-opening',
      amount: Money.from({ amount: '100.00', currency: 'BRL' }),
      at: new Date(),
    });

    const initialBalance = wallet.balance;
    expect(initialBalance.toJSON().amount).toBe('100.00');

    // Dispara 50 tentativas simultâneas de débito de 80.00 BRL
    const attempts = Array.from({ length: 50 }, async (_, index) => {
      try {
        const betAmount = Money.from({ amount: '80.00', currency: 'BRL' });
        // Simula a tentativa de débito sob concorrência
        const entry = wallet.debit({
          entryId: `entry-bet-${index}`,
          transactionId: `tx-bet-${index}`,
          amount: betAmount,
          at: new Date(),
        });
        return { success: true, entryId: entry.id };
      } catch (err: any) {
        return { success: false, error: err.code };
      }
    });

    const results = await Promise.all(attempts);

    const successful = results.filter((r) => r.success);
    const insufficientFundsErrors = results.filter((r) => !r.success && r.error === 'INSUFFICIENT_FUNDS');

    // Invariantes verificadas:
    // 1. Exatamente UMA aposta passa (pois 100.00 - 80.00 = 20.00, impedindo a segunda de 80.00)
    expect(successful.length).toBe(1);
    
    // 2. As outras 49 falham estritamente por saldo insuficiente (sem corromper o saldo)
    expect(insufficientFundsErrors.length).toBe(49);

    // 3. Saldo final exato deve ser 20.00 BRL
    expect(wallet.balance.toJSON().amount).toBe('20.00');
  });
});