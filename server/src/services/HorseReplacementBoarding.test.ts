import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  boardReplacementHorses,
  boardingRequest,
  REPLACEMENT_BOARD,
  REPLACEMENT_OWNER,
  type BoardingAdapter,
} from './HorseReplacementBoarding.js';
import { boardingMode } from '../scripts/boardRetiredHorseReplacements.js';
const ids = JSON.parse(
  readFileSync(
    new URL('../../../scripts/ci/fixtures/patterned-horse-retirement-cohort.json', import.meta.url),
    'utf8'
  )
) as string[];
const rows = ids.map((id, i) => ({
  retiredHorseId: id,
  horseId: `8b27a10f-e57b-47d9-9af0-${String(i).padStart(12, '0')}`,
}));
function fixture() {
  const members = new Map<string, any>(),
    receipts = new Map<string, any>();
  const member = (id: string) => ({
    club_id: REPLACEMENT_BOARD,
    user_id: id,
    role: 'player',
    status: 'active',
    is_active: true,
    membership_lifecycle_status: 'active',
    invited_by: REPLACEMENT_OWNER,
    agent_id: REPLACEMENT_OWNER as string | null,
    player_rakeback_pct: 0,
    player_rakeback_explicit: false,
  });
  const a = {
    referralAgent: vi.fn(async (): Promise<string | null> => REPLACEMENT_OWNER),
    plan: vi.fn(async () => ({
      batch: 'patterned-retirement-20261006',
      completed_replacements: 62,
      eligible_active: 1000,
      active_roster: 1000,
      replacements: rows,
    })),
    verify: vi.fn(async () => {}),
    board: vi.fn(async () => ({ count: 434 + members.size, maximum: 500 })),
    member: vi.fn(async (id: string) => members.get(id) ?? null),
    receipt: vi.fn(async (id: string, key: string) => receipts.get(key) ?? null),
    join: vi.fn(async (r: (typeof rows)[number], key: string) => {
      const m = member(r.horseId);
      members.set(r.horseId, m);
      const receipt = {
        success: true,
        club: { id: REPLACEMENT_BOARD },
        status: 'active',
        membership: m,
      };
      receipts.set(key, receipt);
      return receipt;
    }),
  } satisfies BoardingAdapter;
  return { a, members, receipts, member };
}
describe('finite original DSS boarding', () => {
  it('does not treat missing canonical counts as a ready population', async () => {
    const { a } = fixture();
    a.plan.mockResolvedValueOnce({ ...(await a.plan()), eligible_active: undefined } as any);
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('Complete canonical');
    expect(a.join).not.toHaveBeenCalled();
  });
  it('retains the same original key when both acknowledgement and readback are unavailable', async () => {
    const { a } = fixture();
    a.join.mockRejectedValue(Error('unknown'));
    a.receipt.mockResolvedValueOnce(null).mockRejectedValueOnce(Error('read unavailable'));
    await expect(boardReplacementHorses(true, a)).rejects.toThrow(boardingRequest(rows[0]));
    expect(a.join).toHaveBeenCalledTimes(1);
  });
  it('inspection performs no login/join and accepts only complete births', async () => {
    const { a } = fixture();
    expect(await boardReplacementHorses(false, a)).toMatchObject({
      remaining: 62,
      current_members: 434,
    });
    expect(a.join).not.toHaveBeenCalled();
    a.plan.mockResolvedValueOnce({ completed_replacements: 61 } as any);
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('Complete canonical');
  });
  it('uses exactly62 stable original keys and owner-direct normal receipts, without claimingfunding/seats/70', async () => {
    const { a } = fixture();
    expect(await boardReplacementHorses(true, a)).toMatchObject({
      boarded: 62,
      members: 496,
      staff_rakeback_terms_pending: 62,
      funded: false,
      seated: false,
    });
    expect(a.join).toHaveBeenCalledTimes(62);
    for (const [r, key] of a.join.mock.calls) expect(key).toBe(boardingRequest(r));
  });
  it('resumes a partial batch without repeating accepted joins', async () => {
    const { a } = fixture();
    const join = a.join.getMockImplementation()!;
    a.join.mockImplementation(async (r, key) => {
      if (r.horseId === rows[2].horseId) throw Error('lost before send');
      return join(r, key);
    });
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('outcome unknown');
    expect(a.join).toHaveBeenCalledTimes(3);
    a.join.mockImplementation(join);
    a.join.mockClear();
    await boardReplacementHorses(true, a);
    expect(a.join).toHaveBeenCalledTimes(60);
    expect(a.join.mock.calls[0][1]).toBe(boardingRequest(rows[2]));
  });
  it('recovers lost successful acknowledgement from original durable receipt once', async () => {
    const { a } = fixture();
    const join = a.join.getMockImplementation()!;
    a.join.mockImplementation(async (r, key) => {
      await join(r, key);
      throw Error('ack lost');
    });
    await boardReplacementHorses(true, a);
    expect(a.join).toHaveBeenCalledTimes(62);
  });
  it('preserves explicit permission refusal and stops after one original operation', async () => {
    const { a } = fixture();
    a.join.mockResolvedValue({ success: false, code: 'not_authorized' } as any);
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('Original join refused');
    expect(a.join).toHaveBeenCalledTimes(1);
  });
  it('refuses changed metadata before any join', async () => {
    const { a } = fixture();
    a.verify.mockRejectedValueOnce(Error('metadata changed'));
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('metadata changed');
    expect(a.join).not.toHaveBeenCalled();
  });
  it('refuses unknown preexisting memberships rather than adopting or reassigning', async () => {
    const { a, members, member } = fixture();
    members.set(rows[0].horseId, member(rows[0].horseId));
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('receipt scope');
    expect(a.join).not.toHaveBeenCalled();
  });
  it('preserves an existing different agent without overwriting it', async () => {
    const { a, members, member } = fixture();
    members.set(rows[0].horseId, { ...member(rows[0].horseId), agent_id: 'another-agent' });
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('scope changed');
    expect(a.join).not.toHaveBeenCalled();
  });
  it('resumes the original owner-as-agent receipt without repeating its accepted join', async () => {
    const { a, members, receipts, member } = fixture();
    a.referralAgent.mockResolvedValue(REPLACEMENT_OWNER);
    const m = { ...member(rows[0].horseId), agent_id: REPLACEMENT_OWNER };
    members.set(rows[0].horseId, m);
    receipts.set(boardingRequest(rows[0]), {
      success: true,
      club: { id: REPLACEMENT_BOARD },
      status: 'active',
      membership: m,
    });
    const join = a.join.getMockImplementation()!;
    a.join.mockImplementation(async (r, key) => {
      const receipt = await join(r, key);
      receipt.membership.agent_id = REPLACEMENT_OWNER;
      return receipt;
    });
    const original = JSON.stringify({ member: m, receipt: receipts.get(boardingRequest(rows[0])) });
    expect(await boardReplacementHorses(true, a)).toMatchObject({ boarded: 62, members: 496 });
    expect(
      JSON.stringify({
        member: members.get(rows[0].horseId),
        receipt: receipts.get(boardingRequest(rows[0])),
      })
    ).toBe(original);
    expect(a.join).toHaveBeenCalledTimes(61);
    expect(a.join.mock.calls.every(([r]) => r.horseId !== rows[0].horseId)).toBe(true);
  });
  it('refuses a receipt that disagrees with the actual original owner placement', async () => {
    const { a, members, receipts, member } = fixture();
    const m = member(rows[0].horseId);
    members.set(rows[0].horseId, m);
    receipts.set(boardingRequest(rows[0]), {
      success: true,
      club: { id: REPLACEMENT_BOARD },
      status: 'active',
      membership: { ...m, agent_id: null },
    });
    const original = JSON.stringify(m);
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('scope changed');
    expect(a.join).not.toHaveBeenCalled();
    expect(JSON.stringify(m)).toBe(original);
  });
  it('stops on authority drift before another join and retains accepted records', async () => {
    const { a, members } = fixture();
    a.referralAgent
      .mockResolvedValueOnce(REPLACEMENT_OWNER)
      .mockResolvedValueOnce(REPLACEMENT_OWNER)
      .mockResolvedValue(null);
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('authority changed');
    expect(members.size).toBe(1);
    expect(a.join).toHaveBeenCalledTimes(1);
  });
  it('refuses arbitrary referral agents before a subject session', async () => {
    const { a } = fixture();
    a.referralAgent.mockResolvedValue('another-agent');
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('authority unavailable');
    expect(a.join).not.toHaveBeenCalled();
  });
  it('refuses insufficient current capacity before first join', async () => {
    const { a } = fixture();
    a.board.mockResolvedValue({ count: 439, maximum: 500 });
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('headroom');
    expect(a.join).not.toHaveBeenCalled();
  });
  it('stops on concurrent capacity drift while retaining accepted joins', async () => {
    const { a, members } = fixture();
    a.board.mockImplementation(async () => ({
      count: 434 + members.size + (members.size ? 1 : 0),
      maximum: 500,
    }));
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('capacity changed');
    expect(members.size).toBe(1);
  });
  it('does not mask local-session cleanup failure with an accepted join receipt', async () => {
    const { a } = fixture();
    const join = a.join.getMockImplementation()!;
    a.join.mockImplementation(async (r, key) => {
      await join(r, key);
      throw Error('Original subject local cleanup unknown');
    });
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('cleanup unknown');
    expect(a.join).toHaveBeenCalledTimes(1);
  });
  it('rejects a different original cohort and duplicate newids', async () => {
    const { a } = fixture();
    a.plan.mockResolvedValueOnce({
      ...(await a.plan()),
      replacements: rows.map((r, i) =>
        i ? r : { ...r, retiredHorseId: '00000000-0000-0000-0000-000000000fff' }
      ),
    });
    await expect(boardReplacementHorses(true, a)).rejects.toThrow('cohort changed');
    expect(a.join).not.toHaveBeenCalled();
  });
  it('requires explicit finite CLI modes', () => {
    expect(boardingMode([])).toBe(false);
    expect(boardingMode(['--execute'])).toBe(true);
    expect(() => boardingMode(['--execute', '--retry'])).toThrow();
  });
});
