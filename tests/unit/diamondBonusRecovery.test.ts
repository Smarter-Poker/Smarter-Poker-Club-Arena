import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';
const receipt = fixtures.receipts.mines;
import {
  pendingBonus,
  rememberBonus,
  clearPendingBonus,
  PriorBonusPending,
} from '../../src/services/diamondBonusRecovery';
import {
  DiamondBonusService,
  BonusRefusal,
  BonusUnreadable,
  BONUS_NOT_SAVED,
  BONUS_NOT_TAKEN,
  BONUS_SENDS_PER_REQUEST,
  bonusErrorKind,
} from '../../src/services/DiamondBonusService';
import { spinErrorKind } from '../../src/services/DiamondWheelService';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
const request = {
  clubId: receipt.club_id,
  game: 'mines' as const,
  budget: { base: receipt.bet_diamonds, doubled: false, denomination: 1 },
  commitId: receipt.commit_id,
  serverSeedHash: receipt.server_seed_hash,
  seed: receipt.client_seed,
  mode: receipt.mode,
  maxSteps: receipt.max_steps,
};
beforeEach(() => {
  sessionStorage.clear();
  rpc.mockReset();
});
describe('a saved bonus remains one wager', () => {
  it.each(['', '   ', 'a'.repeat(65)])(
    'refuses invalid custom seed %s before retaining or sending money',
    async (seed) => {
      await expect(DiamondBonusService.start({ ...request, seed }, 'alice')).rejects.toBeInstanceOf(
        BonusRefusal
      );
      expect(rpc).not.toHaveBeenCalled();
      expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
    }
  );
  it('keeps an unanswered request across reload and refuses a replacement before any RPC', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: Error('Connection lost') });
    await expect(DiamondBonusService.start(request, 'alice')).rejects.toThrow('Connection lost');
    expect(pendingBonus('alice', request.clubId, 'mines')).toEqual(request);
    expect(pendingBonus('bob', request.clubId, 'mines')).toBeNull();
    await expect(
      DiamondBonusService.start(
        { ...request, commitId: '00000000-0000-0000-0000-000000000005' },
        'alice'
      )
    ).rejects.toThrow('Previous Bonus');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('clears only a verified exact receipt or a definitive transactional refusal', async () => {
    rpc.mockResolvedValue({ data: { ok: false, error: 'Not Enough Diamonds' }, error: null });
    await expect(DiamondBonusService.start(request, 'alice')).rejects.toBeInstanceOf(BonusRefusal);
    expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
    const result = {
      ...receipt,
      bonus: {
        id: '00000000-0000-0000-0000-000000000004',
        base_diamonds: receipt.bet_diamonds,
        added_diamonds: 0,
        total_diamonds: receipt.bet_diamonds,
      },
    };
    rpc.mockResolvedValueOnce({
      data: { ...result, bonus: { ...result.bonus, added_diamonds: 1 } },
      error: null,
    });
    await expect(DiamondBonusService.start(request, 'alice')).rejects.toThrow(
      'Could Not Be Verified'
    );
    expect(pendingBonus('alice', request.clubId, 'mines')).toEqual(request);
    rpc.mockResolvedValueOnce({ data: result, error: null });
    await expect(DiamondBonusService.start(request, 'alice')).resolves.toEqual(result);
    expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
  });
  it('cannot erase another account or another ticket', () => {
    rememberBonus('alice', request);
    rememberBonus('bob', request);
    clearPendingBonus('alice', { ...request, commitId: '00000000-0000-0000-0000-000000000009' });
    expect(pendingBonus('alice', request.clubId, 'mines')).toEqual(request);
    clearPendingBonus('alice', request);
    expect(pendingBonus('bob', request.clubId, 'mines')).toEqual(request);
  });
  it('requires a commitment for fresh play but can recover an unchanged older saved wager', async () => {
    const { serverSeedHash: _hash, ...legacy } = request;
    // Refused before anything is sent: a refusal the page lets go of, never an
    // unknown answer it would resend for ever.
    const refusal = await DiamondBonusService.start(legacy, 'alice').catch((e) => e);
    expect(refusal).toBeInstanceOf(BonusRefusal);
    expect((refusal as BonusRefusal).message).toBe(BONUS_NOT_SAVED);
    expect((refusal as BonusRefusal).ticketGone).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    sessionStorage.setItem(
      `diamond-spins-pending:alice:${request.clubId}:mines`,
      JSON.stringify(legacy)
    );
    const result = {
      ...receipt,
      bonus: {
        id: '00000000-0000-0000-0000-000000000004',
        base_diamonds: receipt.bet_diamonds,
        added_diamonds: 0,
        total_diamonds: receipt.bet_diamonds,
      },
    };
    rpc.mockResolvedValueOnce({ data: result, error: null });
    await expect(DiamondBonusService.start(legacy, 'alice')).resolves.toEqual(result);
    expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
  });
  it('retains the original hash after a substituted valid-looking commitment response', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ...receipt,
        server_seed_hash: 'f'.repeat(64),
        proof: { ...receipt.proof, server_seed_hash: 'f'.repeat(64) },
        bonus: {
          id: receipt.id,
          base_diamonds: receipt.bet_diamonds,
          added_diamonds: 0,
          total_diamonds: receipt.bet_diamonds,
        },
      },
      error: null,
    });
    await expect(DiamondBonusService.start(request, 'alice')).rejects.toThrow(
      'Could Not Be Verified'
    );
    expect(pendingBonus('alice', request.clubId, 'mines')?.serverSeedHash).toBe(
      receipt.server_seed_hash
    );
  });
  it('refuses before sending if durable session recovery cannot be written', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw Error('Storage unavailable');
      },
    });
    try {
      // Nothing left the browser, so nothing was charged: a refusal the page
      // settles by letting go, not an unknown answer it would resend for ever.
      const refusal = await DiamondBonusService.start(request, 'alice').catch((e) => e);
      expect(refusal).toBeInstanceOf(BonusRefusal);
      expect((refusal as BonusRefusal).message).toBe(BONUS_NOT_SAVED);
      expect((refusal as BonusRefusal).ticketGone).toBe(false);
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
describe('a saved bonus settles itself (owner ruling 2026-09-21: no game asks for a check)', () => {
  it('a conflicting saved wager is handed to the page, which settles it first', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: Error('Connection lost') });
    await expect(DiamondBonusService.start(request, 'alice')).rejects.toThrow('Connection lost');
    const replacement = { ...request, commitId: '00000000-0000-0000-0000-000000000005' };
    const refusal = await DiamondBonusService.start(replacement, 'alice').catch((e) => e);
    expect(refusal).toBeInstanceOf(PriorBonusPending);
    expect((refusal as PriorBonusPending).prior).toEqual(request);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('a saved wager that cannot be replayed is discarded, not thrown, so the page loads', () => {
    const key = `diamond-spins-pending:alice:${request.clubId}:mines`;
    sessionStorage.setItem(key, '{not json');
    expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
    sessionStorage.setItem(key, JSON.stringify({ ...request, commitId: 'not-a-ticket' }));
    expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('a ticket the server no longer holds is a refusal the page re-deals by itself', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: false, ticket: 'gone', error: 'That Ticket Expired. A New One Is Being Dealt' },
      error: null,
    });
    const refusal = await DiamondBonusService.start(request, 'alice').catch((e) => e);
    expect(refusal).toBeInstanceOf(BonusRefusal);
    expect((refusal as BonusRefusal).ticketGone).toBe(true);
    // Nothing was charged, so nothing is saved.
    expect(pendingBonus('alice', request.clubId, 'mines')).toBeNull();
    rpc.mockResolvedValueOnce({ data: { ok: false, error: 'Not Enough Diamonds' }, error: null });
    const ordinary = await DiamondBonusService.start(request, 'alice').catch((e) => e);
    expect((ordinary as BonusRefusal).ticketGone).toBe(false);
  });
});

describe('a saved wager is judged by its own game', () => {
  it('keeps a 25-diamond Donkey Cross award wager whose drop value does not divide it', () => {
    // Review 2026-09-21: the drop value only matters to Plinko, but every read
    // used to require it to divide the total, deleting this live wager.
    const small = {
      ...request,
      game: 'crossing' as const,
      budget: {
        base: 25,
        doubled: false,
        denomination: 10,
        award: {
          id: '00000000-0000-0000-0000-000000000077',
          entryDiamonds: 25,
          boostMultiplier: 1,
        },
      },
    };
    rememberBonus('alice', small);
    expect(pendingBonus('alice', small.clubId, 'crossing')).toEqual(small);
    expect(pendingBonus('alice', small.clubId, 'crossing')).toEqual(small);
  });
  it('still discards a Plinko wager its drop value cannot split', () => {
    const uneven = {
      ...request,
      game: 'plinko' as const,
      budget: { base: 25, doubled: false, denomination: 10 },
    };
    sessionStorage.setItem(
      `diamond-spins-pending:alice:${request.clubId}:plinko`,
      JSON.stringify(uneven)
    );
    expect(pendingBonus('alice', request.clubId, 'plinko')).toBeNull();
  });
});

/**
 * AN ERROR THE DATABASE ANSWERED IS AN ANSWER (review finding 2, 2026-09-22).
 * A start RPC error with a SQLSTATE means that execution rolled back and no
 * earlier send of the request committed (the replay branch would have answered
 * it with its receipt). The award pages used to keep such a wager and resend
 * it every eight seconds for ever, with the exit guard holding the player.
 */
describe('an error the database answered is an answer', () => {
  let ticket = 0;
  /** A request on a ticket no other test has used, so no count carries over. */
  const fresh = () => ({
    ...request,
    commitId: `00000000-0000-4000-8000-${String(++ticket).padStart(12, '0')}`,
  });
  const failure = (code: string) => ({
    data: null,
    error: { code, message: 'The database said no', details: '', hint: '' },
  });
  const saved = () => pendingBonus('alice', request.clubId, 'mines');
  const answer = {
    ...receipt,
    bonus: {
      id: '00000000-0000-0000-0000-000000000004',
      base_diamonds: receipt.bet_diamonds,
      added_diamonds: 0,
      total_diamonds: receipt.bet_diamonds,
    },
  };
  /** The receipt for exactly this request. */
  const receiptFor = (input: { commitId: string }) => ({ ...answer, commit_id: input.commitId });

  it.each(['23503', '23514', 'P0001', '42883', '22P02', 'PGRST116', 'PGRST202', 'PGRST301'])(
    'refuses at once on %s: the saved wager is cleared and nothing is sent again',
    async (code) => {
      const input = fresh();
      rpc.mockResolvedValue(failure(code));
      const refusal = await DiamondBonusService.start(input, 'alice').catch((e) => e);
      expect(refusal).toBeInstanceOf(BonusRefusal);
      expect((refusal as BonusRefusal).message).toBe(BONUS_NOT_TAKEN);
      expect((refusal as BonusRefusal).ticketGone).toBe(false);
      expect(saved()).toBeNull();
      expect(rpc).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['40001', '40P01', '55P03', '57014', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'])(
    'lets a passing %s be sent again, as the same request, three times in all',
    async (code) => {
      const input = fresh();
      rpc.mockResolvedValue(failure(code));
      for (let send = 1; send < BONUS_SENDS_PER_REQUEST; send++) {
        const error = await DiamondBonusService.start(input, 'alice').catch((e) => e);
        expect(error).not.toBeInstanceOf(BonusRefusal);
        expect(error).toMatchObject({ code });
        expect(saved()).toEqual(input);
      }
      const refusal = await DiamondBonusService.start(input, 'alice').catch((e) => e);
      expect(refusal).toBeInstanceOf(BonusRefusal);
      expect((refusal as BonusRefusal).message).toBe(BONUS_NOT_TAKEN);
      expect(saved()).toBeNull();
      expect(rpc).toHaveBeenCalledTimes(BONUS_SENDS_PER_REQUEST);
      const sent = rpc.mock.calls.map((call) => JSON.stringify(call));
      expect(new Set(sent).size).toBe(1);
    }
  );

  it('plays the receipt that follows a passing error, on the same request', async () => {
    const input = fresh();
    rpc.mockResolvedValueOnce(failure('40001')).mockResolvedValueOnce({
      data: receiptFor(input),
      error: null,
    });
    await expect(DiamondBonusService.start(input, 'alice')).rejects.toMatchObject({
      code: '40001',
    });
    await expect(DiamondBonusService.start(input, 'alice')).resolves.toEqual(receiptFor(input));
    expect(saved()).toBeNull();
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });

  it.each([
    ['no code', { data: null, error: { code: '', message: 'FetchError: Failed to fetch' } }],
    ['a gateway page', { data: null, error: { message: '<html>Bad Gateway</html>' } }],
  ])('keeps the saved wager and every later send open on %s', async (_why, lost) => {
    const input = fresh();
    rpc.mockResolvedValue(lost);
    for (let send = 0; send < 6; send++) {
      const error = await DiamondBonusService.start(input, 'alice').catch((e) => e);
      expect(error).not.toBeInstanceOf(BonusRefusal);
      expect(error).not.toBeInstanceOf(BonusUnreadable);
      expect(saved()).toEqual(input);
    }
    expect(rpc).toHaveBeenCalledTimes(6);
  });

  it('keeps a wager whose answer will not verify, and marks the third such answer final', async () => {
    const input = fresh();
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
    const finals: boolean[] = [];
    for (let send = 0; send < BONUS_SENDS_PER_REQUEST; send++) {
      const error = await DiamondBonusService.start(input, 'alice').catch((e) => e);
      expect(error).toBeInstanceOf(BonusUnreadable);
      expect((error as Error).message).toBe('The Bonus Response Could Not Be Verified');
      finals.push((error as BonusUnreadable).final);
      // Money may have moved, so the saved wager stays every time.
      expect(saved()).toEqual(input);
    }
    expect(finals).toEqual([false, false, true]);
    // A receipt that verifies still settles it, and clears it.
    rpc.mockResolvedValueOnce({ data: receiptFor(input), error: null });
    await expect(DiamondBonusService.start(input, 'alice')).resolves.toEqual(receiptFor(input));
    expect(saved()).toBeNull();
  });

  it('counts unreadable answers per request', async () => {
    const first = fresh();
    const second = fresh();
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
    for (let send = 0; send < 2; send++)
      await DiamondBonusService.start(first, 'alice').catch(() => null);
    sessionStorage.clear();
    const other = await DiamondBonusService.start(second, 'alice').catch((e) => e);
    expect(other).toBeInstanceOf(BonusUnreadable);
    expect((other as BonusUnreadable).final).toBe(false);
  });

  it('classifies every error exactly as the wheel does', () => {
    const codes = [
      '',
      '23503',
      '23514',
      '40001',
      '40P01',
      '55P03',
      '57014',
      'P0001',
      'PDB01',
      '42883',
      'XX000',
      'PGRST000',
      'PGRST001',
      'PGRST002',
      'PGRST003',
      'PGRST004',
      'PGRST116',
      'PGRST202',
      'PGRST301',
      '4000',
      '400011',
      'abcde',
      '20',
    ];
    const errors: unknown[] = [
      ...codes.map((code) => ({ code, message: 'x' })),
      { message: 'no code at all' },
      { code: 40001 },
      new Error('Connection Lost'),
      null,
      undefined,
      'a string',
    ];
    for (const error of errors) expect(bonusErrorKind(error)).toBe(spinErrorKind(error));
    expect(bonusErrorKind({ code: '23503' })).toBe('refused');
    expect(bonusErrorKind({ code: '40P01' })).toBe('transient');
    expect(bonusErrorKind({ code: 'PGRST002' })).toBe('transient');
    expect(bonusErrorKind({ code: 'PGRST301' })).toBe('refused');
    expect(bonusErrorKind({ code: '' })).toBe('unknown');
  });
});
