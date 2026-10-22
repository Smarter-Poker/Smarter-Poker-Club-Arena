/**
 * A DATABASE ID IS A UUID, NOT A UUID OF A PARTICULAR VERSION (2026-10-21).
 *
 * Client-side twin of a-player-id-is-a-uuid-not-a-uuid-version.law.test.ts.
 * Production ids that are valid Postgres uuids but not RFC version 1-5:
 *   Midway Union (and its house club)  fade0000-0000-0000-0000-000000000001
 *   The Felt Society                   a0000000-0000-0000-0000-000000000001
 *   horses and early accounts          00000000-0000-0000-0000-0000000000NN
 *
 * A version-pinned regex refused every Union Bank pull back with "Invalid
 * Union Wallet Intent", and every agent wallet transfer in The Felt Society or
 * to a horse with "The Transfer Account Could Not Be Verified". The fixtures
 * used v4 ids, so nothing noticed. These cases use the real ones.
 *
 * docs/changelog/2026-10-21-a-database-id-is-a-uuid-not-a-uuid-version.md
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isEntityId } from '../src/utils/entityId';
import {
  reserveDurableUnionWalletOperation,
  reserveUnionWalletOperation,
  unionWalletIntentSignature,
  type UnionWalletRecoveryStorage,
} from '../src/services/UnionWalletRecovery';

const MIDWAY_UNION = 'fade0000-0000-0000-0000-000000000001';
const FELT_SOCIETY = 'a0000000-0000-0000-0000-000000000001';
const HORSE = '00000000-0000-0000-0000-000000000083';
const OWNER = '47965354-0e56-43ef-931c-ddaab82af765';
const KINGS_CLUB = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const OP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

const pullScope = {
  userId: OWNER,
  unionId: MIDWAY_UNION,
  walletKey: 'chips' as const,
  signature: unionWalletIntentSignature({
    mode: 'pull',
    targetType: 'club',
    targetId: KINGS_CLUB,
    kind: 'chips',
    amount: 5_000_000,
    sourceWallet: 'bank',
  }),
};

describe('a database id is checked by shape, never by uuid version', () => {
  it('accepts every real non-v4 production id and still refuses the nil uuid', () => {
    for (const id of [MIDWAY_UNION, FELT_SOCIETY, HORSE, OWNER, KINGS_CLUB]) {
      expect(isEntityId(id)).toBe(true);
    }
    for (const bad of ['00000000-0000-0000-0000-000000000000', '', 'midway-union', 42, null]) {
      expect(isEntityId(bad)).toBe(false);
    }
  });

  it('lets the Midway Union owner reserve a Union Bank pull back', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const rpc = async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return { data: OP, error: null };
    };
    await expect(
      reserveDurableUnionWalletOperation(pullScope, rpc, new MemoryStorage())
    ).resolves.toBe(OP);
    expect(calls[0]?.p_union_id).toBe(MIDWAY_UNION);
    expect(reserveUnionWalletOperation(pullScope, new MemoryStorage(), Date.now(), () => OP)).toBe(
      OP
    );
  });

  it('validates database ids with the shared shape check in every money and join path', () => {
    const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
    const VERSION_PINNED = /\[1-[58]\]\[0-9a-f\]\{3\}-\[89ab\]/;
    const union = read('src/services/UnionWalletRecovery.ts');
    expect(union).toMatch(/isEntityId\(scope\.userId\)/);
    expect(union).toMatch(/isEntityId\(scope\.unionId\)/);
    const agent = read('src/services/AgentWalletIntent.ts');
    expect(agent).toMatch(
      /\[intent\.userId, intent\.clubId, intent\.targetId\]\.every\(\(id\) => isEntityId\(id\)\)/
    );
    const pending = read('src/components/wallet/CashierPendingOperations.tsx');
    expect(pending).toMatch(/isEntityId\(routeClubId\)/);
    expect(pending).not.toMatch(VERSION_PINNED);
    const join_ = read('src/services/ClubJoinService.ts');
    expect(join_).toMatch(/isEntityId\(normalized\)/);
    expect(join_).not.toMatch(VERSION_PINNED);
  });
});
