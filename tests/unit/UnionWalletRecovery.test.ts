import { describe, expect, it } from 'vitest';
import {
  clearUnionWalletOperation,
  reserveUnionWalletOperation,
  unionWalletIntentSignature,
  type UnionWalletRecoveryStorage,
} from '../../src/services/UnionWalletRecovery';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const UNION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OP_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = Date.UTC(2026, 8, 6, 12);

class MemoryStorage implements UnionWalletRecoveryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const signature = (amount = 250) =>
  unionWalletIntentSignature({
    mode: 'send',
    targetType: 'club',
    targetId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    kind: 'chips',
    amount,
    sourceWallet: 'chips',
  });

const scope = (userId = USER_A, intentSignature = signature()) => ({
  userId,
  unionId: UNION_ID,
  walletKey: 'chips' as const,
  signature: intentSignature,
});

describe('Union Wallet intent recovery', () => {
  it('reuses one durable operation id for the same unresolved intent', () => {
    const storage = new MemoryStorage();

    expect(reserveUnionWalletOperation(scope(), storage, NOW, () => OP_A)).toBe(OP_A);
    expect(reserveUnionWalletOperation(scope(), storage, NOW + 1_000, () => OP_B)).toBe(OP_A);
    expect(
      reserveUnionWalletOperation(scope(USER_A, signature(251)), storage, NOW, () => OP_B)
    ).toBe(OP_B);
  });

  it('isolates recovery records by authenticated user', () => {
    const storage = new MemoryStorage();

    expect(reserveUnionWalletOperation(scope(USER_A), storage, NOW, () => OP_A)).toBe(OP_A);
    expect(reserveUnionWalletOperation(scope(USER_B), storage, NOW, () => OP_B)).toBe(OP_B);
    expect(reserveUnionWalletOperation(scope(USER_A), storage, NOW, () => OP_B)).toBe(OP_A);
    expect(storage.values.size).toBe(2);
  });

  it('isolates simultaneous intents in the same wallet without a shared envelope', () => {
    const storage = new MemoryStorage();
    const first = scope(USER_A, signature(250));
    const second = scope(USER_A, signature(251));

    expect(reserveUnionWalletOperation(first, storage, NOW, () => OP_A)).toBe(OP_A);
    expect(reserveUnionWalletOperation(second, storage, NOW, () => OP_B)).toBe(OP_B);
    expect(storage.values.size).toBe(2);

    clearUnionWalletOperation(first, OP_A, storage, NOW + 1);
    expect(storage.values.size).toBe(1);
    expect(reserveUnionWalletOperation(second, storage, NOW + 2, () => OP_A)).toBe(OP_B);
  });

  it('clears only a server-confirmed operation so the next deliberate send gets a new id', () => {
    const storage = new MemoryStorage();
    const intent = scope();

    expect(reserveUnionWalletOperation(intent, storage, NOW, () => OP_A)).toBe(OP_A);
    clearUnionWalletOperation(intent, OP_A, storage, NOW);
    expect(reserveUnionWalletOperation(intent, storage, NOW + 1, () => OP_B)).toBe(OP_B);
  });

  it('fails closed when recovery cannot be written and read back', () => {
    const silentlyDiscarding: UnionWalletRecoveryStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const throwing: UnionWalletRecoveryStorage = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => undefined,
    };

    expect(reserveUnionWalletOperation(scope(), silentlyDiscarding, NOW, () => OP_A)).toBeNull();
    expect(reserveUnionWalletOperation(scope(), throwing, NOW, () => OP_A)).toBeNull();
  });

  it('does not replace malformed recovery with a fresh key', () => {
    const storage = new MemoryStorage();
    const intent = scope();
    expect(reserveUnionWalletOperation(intent, storage, NOW, () => OP_A)).toBe(OP_A);
    const [key] = storage.values.keys();
    storage.values.set(key, '{not-json');

    expect(reserveUnionWalletOperation(intent, storage, NOW, () => OP_B)).toBeNull();
    expect(storage.values.get(key)).toBe('{not-json');
  });
});
