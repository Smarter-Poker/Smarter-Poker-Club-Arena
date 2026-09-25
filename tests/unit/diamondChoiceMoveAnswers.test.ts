/**
 * What an answer to a Donkey Cross or Diamond Mines move says (review 2026-09-22).
 *
 * fn_choice_act answers a move it will not make with {ok:false,error} and
 * changes nothing; the page must show that reason, not read it as a lost
 * answer. An error that carries a SQLSTATE is the database's answer as well:
 * that execution rolled back (the same rule the start door follows,
 * bonusErrorKind). Only an error that may pass, or one with no code at all,
 * leaves the page to read the round back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';
import {
  ChoiceMoveRefused,
  DiamondChoiceService,
  MOVE_NOT_TAKEN,
  moveRefusedByDatabase,
  parseChoiceRound,
} from '../../src/services/DiamondChoiceService';
import { bonusErrorKind } from '../../src/services/DiamondBonusService';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
const open = parseChoiceRound({
  ...fixtures.receipts.mines,
  status: 'open',
  picked: [],
  proof: null,
  payout_chips: 0,
});
const answer = () => DiamondChoiceService.act(open, 'pick', 8).catch((error: unknown) => error);
beforeEach(() => rpc.mockReset());

describe('an answer to a move', () => {
  it("that the server wrote is a refusal carrying the server's own reason", async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: false, error: 'The Platform Is In Its Maintenance Break' },
      error: null,
    });
    const refusal = await answer();
    expect(refusal).toBeInstanceOf(ChoiceMoveRefused);
    expect((refusal as Error).message).toBe('The Platform Is In Its Maintenance Break');
  });

  it.each(['P0001', '23505', '42501', 'PGRST116', 'PGRST202'])(
    'that the database raised (%s) is a refusal: nothing moved',
    async (code) => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code, message: 'Prize Exceeds Its Reservation' },
      });
      const refusal = await answer();
      expect(refusal).toBeInstanceOf(ChoiceMoveRefused);
      expect((refusal as Error).message).toBe(MOVE_NOT_TAKEN);
    }
  );

  it.each(['40001', '40P01', '55P03', '57014', 'PGRST000', 'PGRST003', ''])(
    'that may pass (%s) is no answer, so the round is read back',
    async (code) => {
      const failure = { code, message: 'Could Not Serialize Access' };
      rpc.mockResolvedValueOnce({ data: null, error: failure });
      const error = await answer();
      expect(error).not.toBeInstanceOf(ChoiceMoveRefused);
      expect(error).toBe(failure);
    }
  );

  it('that never arrived is no answer', async () => {
    const lost = new TypeError('Failed To Fetch');
    rpc.mockRejectedValueOnce(lost);
    const error = await answer();
    expect(error).not.toBeInstanceOf(ChoiceMoveRefused);
    expect(error).toBe(lost);
  });

  it('that this browser cannot verify is not a refusal', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, id: 'not a round' }, error: null });
    const error = await answer();
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChoiceMoveRefused);
  });

  it('that moved the round is the round', async () => {
    const next = { ...open, picked: [8] };
    rpc.mockResolvedValueOnce({ data: next, error: null });
    await expect(DiamondChoiceService.act(open, 'pick', 8)).resolves.toEqual(next);
    expect(rpc).toHaveBeenLastCalledWith('fn_choice_act', {
      p_round_id: open.id,
      p_action: 'pick',
      p_cell: 8,
      p_expected_step: 0,
    });
  });
});

it('reads every database error by the rule the start doors follow', () => {
  const codes = [
    ...['P0001', '23505', '23503', '42501', '42883', '22P02', 'XX000', '40001', '40P01'],
    ...['55P03', '57014', '08006', '53300', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'],
    ...['PGRST100', 'PGRST116', 'PGRST202', 'PGRST301', '', '404', 'Timeout'],
  ];
  for (const code of codes)
    expect(moveRefusedByDatabase({ code }), code).toBe(bonusErrorKind({ code }) === 'refused');
  expect(moveRefusedByDatabase(new TypeError('Failed To Fetch'))).toBe(false);
  expect(moveRefusedByDatabase(null)).toBe(false);
});
