import { describe, expect, it, vi } from 'vitest';
import {
  claimFinalTableTransition,
  hasReachedFinalTableShape,
  mayBecomeFinalTable,
  type FinalTableTransitionStore,
} from './finalTableTransition.js';

describe('Final Table format eligibility', () => {
  it('accepts only persisted unlimited MTT contracts', () => {
    expect(mayBecomeFinalTable({ format_contract: 'mtt-v1' })).toBe(true);
    expect(mayBecomeFinalTable({ format_contract: 'mtt-v2' })).toBe(true);
    expect(mayBecomeFinalTable({ format_contract: 'spin-v1' })).toBe(false);
    expect(mayBecomeFinalTable({ format_contract: 'sng-v1' })).toBe(false);
    expect(mayBecomeFinalTable({ format_contract: 'seat-first-satellite-v1' })).toBe(false);
  });

  it('fails closed for missing, unknown, or unpersisted format evidence', () => {
    expect(mayBecomeFinalTable(null)).toBe(false);
    expect(mayBecomeFinalTable({})).toBe(false);
    expect(mayBecomeFinalTable({ format_contract: 'future-v1' })).toBe(false);
    expect(mayBecomeFinalTable({ tournament_type: 'MTT' })).toBe(false);
  });
});

describe('Final Table shape', () => {
  it('requires a readable positive headcount on exactly one live table', () => {
    expect(hasReachedFinalTableShape(9, 9, 1)).toBe(true);
    expect(hasReachedFinalTableShape(1, 9, 1)).toBe(true);
    expect(hasReachedFinalTableShape(null, 9, 1)).toBe(false);
    expect(hasReachedFinalTableShape(0, 9, 1)).toBe(false);
    expect(hasReachedFinalTableShape(10, 9, 1)).toBe(false);
    expect(hasReachedFinalTableShape(9, 9, null)).toBe(false);
    expect(hasReachedFinalTableShape(9, 9, 2)).toBe(false);
  });
});

describe('durable Final Table transition', () => {
  it('recovers its committed receipt after a lost response without giving a restart the announcement', async () => {
    const firstOwner = '11111111-1111-4111-8111-111111111111';
    const restartedOwner = '22222222-2222-4222-8222-222222222222';
    let receipt: { ownershipToken: string; announced: boolean } | null = null;
    let loseCommitResponse = true;
    let announcements = 0;

    const store: FinalTableTransitionStore = {
      persistIfUnset: vi.fn(async (ownershipToken) => {
        if (!receipt) {
          receipt = { ownershipToken, announced: false };
          if (loseCommitResponse) {
            loseCommitResponse = false;
            throw new Error('response lost after commit');
          }
        }
        return {
          changed: receipt.ownershipToken === ownershipToken && !receipt.announced,
          error: null,
        };
      }),
      readPersisted: vi.fn(async () => ({
        triggered: receipt !== null,
        ownershipToken: receipt?.ownershipToken ?? null,
        announced: receipt?.announced ?? null,
        error: null,
      })),
    };

    const recoveredOwner = await claimFinalTableTransition(store, firstOwner);
    if (recoveredOwner.state === 'newly_persisted') {
      announcements += 1;
      const committedReceipt = receipt as {
        ownershipToken: string;
        announced: boolean;
      } | null;
      if (committedReceipt) committedReceipt.announced = true;
    }

    expect(recoveredOwner.state).toBe('newly_persisted');
    expect(announcements).toBe(1);

    const restartedEngine = await claimFinalTableTransition(store, restartedOwner);
    if (restartedEngine.state === 'newly_persisted') announcements += 1;
    expect(restartedEngine.state).toBe('already_persisted');
    expect(announcements).toBe(1);
  });

  it('retries a write failure, announces one durable claim, and hydrates a restart', async () => {
    const firstOwner = '33333333-3333-4333-8333-333333333333';
    const restartedOwner = '44444444-4444-4444-8444-444444444444';
    let durable = false;
    let durableOwner: string | null = null;
    let announced = false;
    let persistAttempts = 0;
    let announcements = 0;
    const store: FinalTableTransitionStore = {
      persistIfUnset: vi.fn(async (ownershipToken) => {
        persistAttempts += 1;
        if (persistAttempts === 1) {
          return { changed: false, error: new Error('temporary database failure') };
        }
        if (durable) {
          return {
            changed: durableOwner === ownershipToken && !announced,
            error: null,
          };
        }
        durable = true;
        durableOwner = ownershipToken;
        return { changed: true, error: null };
      }),
      readPersisted: vi.fn(async () => ({
        triggered: durable,
        ownershipToken: durableOwner,
        announced,
        error: null,
      })),
    };

    const failedSweep = await claimFinalTableTransition(store, firstOwner);
    if (failedSweep.state === 'newly_persisted') announcements += 1;
    expect(failedSweep.state).toBe('retry');
    expect(durable).toBe(false);

    const retrySweep = await claimFinalTableTransition(store, firstOwner);
    if (retrySweep.state === 'newly_persisted') {
      announcements += 1;
      announced = true;
    }
    expect(retrySweep.state).toBe('newly_persisted');
    expect(durable).toBe(true);

    const restartedEngine = await claimFinalTableTransition(store, restartedOwner);
    if (restartedEngine.state === 'newly_persisted') announcements += 1;
    expect(restartedEngine.state).toBe('already_persisted');
    expect(announcements).toBe(1);
    expect(store.readPersisted).toHaveBeenCalledTimes(2);
  });

  it('never treats an unreadable or false follow-up read as durable truth', async () => {
    const unreadable = await claimFinalTableTransition(
      {
        persistIfUnset: async () => ({ changed: false, error: null }),
        readPersisted: async () => ({
          triggered: null,
          ownershipToken: null,
          announced: null,
          error: new Error('read failed'),
        }),
      },
      '55555555-5555-4555-8555-555555555555'
    );
    expect(unreadable.state).toBe('retry');

    const stillFalse = await claimFinalTableTransition(
      {
        persistIfUnset: async () => ({ changed: false, error: null }),
        readPersisted: async () => ({
          triggered: false,
          ownershipToken: null,
          announced: null,
          error: null,
        }),
      },
      '66666666-6666-4666-8666-666666666666'
    );
    expect(stillFalse.state).toBe('retry');
  });

  it('turns thrown transport failures into retry results', async () => {
    const thrownWrite = await claimFinalTableTransition(
      {
        persistIfUnset: async () => Promise.reject(new Error('socket closed')),
        readPersisted: async () => ({
          triggered: false,
          ownershipToken: null,
          announced: null,
          error: null,
        }),
      },
      '77777777-7777-4777-8777-777777777777'
    );
    expect(thrownWrite.state).toBe('retry');

    const thrownRead = await claimFinalTableTransition(
      {
        persistIfUnset: async () => ({ changed: false, error: null }),
        readPersisted: async () => Promise.reject(new Error('socket closed')),
      },
      '88888888-8888-4888-8888-888888888888'
    );
    expect(thrownRead.state).toBe('retry');
  });

  it('uses RETURNING success without a redundant read', async () => {
    const readPersisted = vi.fn(async () => ({
      triggered: true,
      ownershipToken: '99999999-9999-4999-8999-999999999999',
      announced: false,
      error: null,
    }));
    const result = await claimFinalTableTransition(
      {
        persistIfUnset: async () => ({ changed: true, error: null }),
        readPersisted,
      },
      '99999999-9999-4999-8999-999999999999'
    );

    expect(result.state).toBe('newly_persisted');
    expect(readPersisted).not.toHaveBeenCalled();
  });
});
