import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return {
    supabase: createClient('https://fixture.example.invalid', 'fixture-public-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (...args: Parameters<typeof fetch>) => state.fetch(...args) },
    }),
  };
});
import ClubRosterService from '../../src/services/ClubRosterService';
beforeEach(() => {
  state.fetch.mockReset();
});
function answer(value: unknown) {
  state.fetch.mockResolvedValue(new Response(JSON.stringify(value), { status: 200 }));
}
const metrics = {
  hands: '0',
  hands_won: 0,
  win_rate: 0,
  vpip: 0,
  pfr: 0,
  three_bet: 0,
  three_bets: 0,
  fold_to_three_bet: 0,
  faced_three_bets: 0,
  cbet: 0,
  cbet_opportunities: 0,
  net: '-1.25',
  fees: '0.00',
};
const statistics = {
  authorized: true,
  variant: 'all',
  variants: [],
  ...metrics,
  from: null,
  to: null,
  is_overall: true,
};
const detail = {
  identity: { user_id: 'player' },
  presence: { is_online: false, is_seated: false },
  wallets: { chip_balance: '0', player_wallet: 0, agent_wallet: 0, promo_wallet: 0 },
  downline: { downline_direct: 0, downline_total: 0 },
  stats: {
    hands: '0',
    mtt_hands: 0,
    total_fee: 0,
    mtt_fee: 0,
    claimed_back: 0,
    sent_out: 0,
    total_winnings: '-1.25',
    mtt_winnings: 0,
  },
  range: { from: null, to: null, is_overall: true },
  capabilities: {
    access: 'staff',
    can_view_financials: true,
    can_view_notes: true,
    can_edit_notes: true,
    can_manage_role: true,
  },
};
it.each(Object.keys(metrics))('rejects authorized statistics missing %s', async (key) => {
  const incomplete: Record<string, unknown> = { ...statistics };
  delete incomplete[key];
  answer(incomplete);
  await expect(ClubRosterService.getMemberStatistics('club', 'player')).rejects.toThrow(
    /Incomplete/
  );
  expect(state.fetch).toHaveBeenCalledTimes(1);
});
it.each([null, true, '', 'bad', Infinity])(
  'rejects unreadable statistics numeric %j',
  async (value) => {
    answer({ ...statistics, hands: value });
    await expect(ClubRosterService.getMemberStatistics('club', 'player')).rejects.toThrow(
      /Incomplete/
    );
  }
);
it.each(['wallets', 'downline', 'stats'])(
  'rejects a populated member with incomplete %s',
  async (key) => {
    answer({ ...detail, [key]: {} });
    await expect(ClubRosterService.getMemberDetail('club', 'player')).rejects.toThrow(/Incomplete/);
  }
);
it('preserves true zero totals and numeric strings', async () => {
  answer(statistics);
  await expect(ClubRosterService.getMemberStatistics('club', 'player')).resolves.toMatchObject({
    hands: 0,
    net: -1.25,
  });
  answer(detail);
  await expect(ClubRosterService.getMemberDetail('club', 'player')).resolves.toMatchObject({
    stats: { hands: 0, total_winnings: -1.25 },
  });
});
it('preserves SQL identity-only null financial redactions', async () => {
  answer({
    ...detail,
    wallets: null,
    downline: null,
    stats: null,
    capabilities: { ...detail.capabilities, access: 'identity', can_view_financials: false },
  });
  await expect(ClubRosterService.getMemberDetail('club', 'player')).resolves.toMatchObject({
    wallets: null,
    stats: null,
  });
});
it.each(['restricted', 'not_member'])('preserves explicit %s denial', async (reason) => {
  answer({ authorized: false, reason });
  await expect(ClubRosterService.getMemberStatistics('club', 'player')).resolves.toMatchObject({
    authorized: false,
    reason,
  });
});
it('cancels an abandoned export within its original request', async () => {
  state.fetch.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = ClubRosterService.exportRoster('club', {}, null, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(1));
  controller.abort();
  await rejected;
  expect(state.fetch.mock.calls[0][1].signal.aborted).toBe(true);
});

it.each(['capabilities', 'presence', 'range'])(
  'rejects a missing member envelope %s',
  async (key) => {
    const incomplete: Record<string, unknown> = { ...detail };
    delete incomplete[key];
    answer(incomplete);
    await expect(ClubRosterService.getMemberDetail('club', 'player')).rejects.toThrow(/Incomplete/);
  }
);
it('rejects sensitive null totals while retaining a null not-found identity', async () => {
  answer({ ...detail, stats: null });
  await expect(ClubRosterService.getMemberDetail('club', 'player')).rejects.toThrow(/Incomplete/);
  answer({ ...detail, identity: null });
  await expect(ClubRosterService.getMemberDetail('club', 'player')).resolves.toMatchObject({
    identity: { user_id: null },
  });
});

it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid counter %j', async (value) => {
  answer({ ...statistics, hands: value });
  await expect(ClubRosterService.getMemberStatistics('club', 'player')).rejects.toThrow(
    /Incomplete/
  );
  answer({ ...detail, stats: { ...detail.stats, hands: value } });
  await expect(ClubRosterService.getMemberDetail('club', 'player')).rejects.toThrow(/Incomplete/);
});
it.each([[], 'player', {}, { user_id: '' }].map((identity) => [identity]))(
  'rejects malformed member identity %j',
  async (identity) => {
    answer({ ...detail, identity });
    await expect(ClubRosterService.getMemberDetail('club', 'player')).rejects.toThrow(/Incomplete/);
  }
);

it('recognizes explicit SQL null member access denial', async () => {
  answer(null);
  await expect(ClubRosterService.getMemberDetail('club', 'player')).rejects.toMatchObject({
    name: 'MemberAccessDeniedError',
  });
});

const exportRow = { user_id: 'player', alias: 'Player', role: 'player', total_fees: '0.00' };
const exportReceipt = { success: true, rows: [exportRow], row_count: 1, audit_id: 'audit-proof' };
it.each([null, 'player', 12, true, [], {}, { user_id: '' }, { user_id: '   ' }])(
  'rejects a malformed export row %j through the actual RPC decoder',
  async (row) => {
    answer({ ...exportReceipt, rows: [row] });
    await expect(ClubRosterService.exportRoster('club', {})).rejects.toThrow(/Incomplete/);
    expect(state.fetch).toHaveBeenCalledTimes(1);
  }
);
it.each([{}, [], true, 12, '', '   ', null])(
  'rejects malformed export audit identity %j without inventing text',
  async (auditId) => {
    answer({ ...exportReceipt, audit_id: auditId });
    await expect(ClubRosterService.exportRoster('club', {})).rejects.toThrow(/Incomplete/);
    expect(state.fetch).toHaveBeenCalledTimes(1);
  }
);
it.each([true, false, null, '', ' ', -1, 1.5, 'bad', 2])(
  'rejects malformed or mismatched export row count %j',
  async (rowCount) => {
    answer({ ...exportReceipt, row_count: rowCount });
    await expect(ClubRosterService.exportRoster('club', {})).rejects.toThrow(/Incomplete/);
    expect(state.fetch).toHaveBeenCalledTimes(1);
  }
);
it('preserves numeric-string export counts and exact server rows, including nullable fields', async () => {
  const row = { ...exportRow, player_wallet: null, total_fees: '12.34', remark: null };
  answer({ ...exportReceipt, rows: [row], row_count: '1' });
  await expect(ClubRosterService.exportRoster('club', {})).resolves.toEqual({
    rows: [row],
    row_count: 1,
    audit_id: 'audit-proof',
  });
  answer({ ...exportReceipt, rows: [], row_count: '0' });
  await expect(ClubRosterService.exportRoster('club', {})).resolves.toEqual({
    rows: [],
    row_count: 0,
    audit_id: 'audit-proof',
  });
});
it('preserves an explicit export authorization refusal', async () => {
  answer({ success: false, error: 'Roster Export Requires Club Staff Access' });
  await expect(ClubRosterService.exportRoster('club', {})).rejects.toThrow(
    'Roster Export Requires Club Staff Access'
  );
  expect(state.fetch).toHaveBeenCalledTimes(1);
});

it('preserves explicit incomplete historical results while decoding current figures', async () => {
  answer({ ...detail, stats: { ...detail.stats, total_winnings: null } });
  await expect(ClubRosterService.getMemberDetail('club', 'player')).resolves.toMatchObject({
    stats: { total_winnings: null, mtt_winnings: 0 },
  });
  expect(new Headers(state.fetch.mock.calls[0][1].headers).get('x-client-info')).toBe(
    'club-arena-member-results/2'
  );
  answer({ ...statistics, net: null });
  await expect(ClubRosterService.getMemberStatistics('club', 'player')).resolves.toMatchObject({
    net: null,
    hands: 0,
  });
  answer({
    today: { cash: 25, mtt: -5, net: 20 },
    week: { cash: 25, mtt: -5, net: 20 },
    month: { cash: 25, mtt: -5, net: 20 },
    overall: { cash: null, mtt: -5, net: null },
  });
  await expect(ClubRosterService.getMemberWinLoss('club', 'player')).resolves.toMatchObject({
    today: { net: 20 },
    overall: { cash: null, net: null, mtt: -5 },
  });
  answer([{ user_id: 'player', cash: null, mtt: -5, net: null, fees: 0, downline_fees: 0 }]);
  expect(
    (await ClubRosterService.getMembersWinLoss('club', ['player'], 'overall')).get('player')?.net
  ).toBeNull();
});
