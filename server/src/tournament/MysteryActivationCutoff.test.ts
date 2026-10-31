import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOP_BOUNTY_PERCENT,
  resolveMysteryBountyProfile,
} from '../config/mysteryBountySpec.js';
import { buildInventoryAtUnit, poolCentsFromNumeric } from './mysteryBountyPool.js';
import { shuffleChests } from './mysteryBountyDraw.js';
import { mysteryPoolCents, shouldActivateMysteryBounty } from './mysteryBountyActivation.js';
import { CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS, tournamentUnitCents } from './tournamentUnit.js';

// Execute the production method and production inventory/predicate helpers.
// The database transport is controlled; this is not a PostgreSQL funding proof.
const source = readFileSync(join(process.cwd(), 'src/tournament/TournamentManagerBase.ts'), 'utf8');
const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true);
const manager = ast.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'TournamentManagerBase'
);
const method = manager?.members.find(
  (node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && node.name.getText(ast) === 'maybeActivateMysteryBounty'
);
const count = ast.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'countPaidPlaces'
);
if (!method || !count) throw new Error('Production mystery activation methods missing');
const lifecycleMethods = [
  'readTournamentClub',
  'tournamentUnit',
  'registerEliminationScheduler',
].map((name) => {
  const member = manager?.members.find(
    (node): node is ts.MethodDeclaration =>
      ts.isMethodDeclaration(node) && node.name.getText(ast) === name
  );
  if (!member) throw new Error(`Production ${name} method missing`);
  return member.getText(ast);
});
const compiled = ts.transpileModule(
  `${count.getText(ast)}\nclass Subject { ${method.getText(ast)}\n${lifecycleMethods.join('\n')} }\nreturn Subject;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;

function fixture(
  options: {
    finalized?: boolean;
    memoryFinalized?: boolean;
    betweenHands?: boolean;
    stage?: string;
    response?: { data: unknown; error: unknown };
    /** fn_mystery_bounty_unrecorded_head_cents' answer (20260911094503). */
    unrecorded?: { data: unknown; error: unknown };
    /** The unit the manager read from the club: a cent, a Diamond, or null
     *  when the club could not be read (Diamond Phase 9). */
    unit?: number | null;
    /** Activation mode and its value (default at_the_money). */
    mode?: string;
    modeValue?: number | null;
    /** tournaments.current_players - the engine drains it to survivors. */
    currentPlayers?: number;
    paidPlaces?: number;
    /** readMysteryTotalEntries' answer: every entry, rebuys included. */
    totalEntries?: number | null;
    /** readUnrecordedKnockoutCount's answer (busts played, not recorded). */
    unrecordedKnockouts?: number | null;
  } = {}
) {
  const fresh = {
    bounty_pool: 1000,
    bounty_pool_paid: 0,
    prize_pool_finalized: options.finalized ?? false,
    mystery_bounty_stage: options.stage ?? 'pending',
    mystery_bounty_pool_percent: 50,
    mystery_bounty_regular_pool_percent: 50,
    mystery_bounty_profile: 'classic',
    mystery_bounty_activation: options.mode ?? 'at_the_money',
    mystery_bounty_activation_value: options.modeValue ?? null,
    mystery_bounty_top_percent: 30,
    payout_structure: Array.from({ length: options.paidPlaces ?? 27 }, (_, i) => ({
      place: i + 1,
      percentage: 1,
    })),
    current_players: options.currentPlayers ?? 180,
  };
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: fresh, error: null })),
  };
  const rpc = vi.fn(async (name: string) =>
    name === 'fn_mystery_bounty_unrecorded_head_cents'
      ? (options.unrecorded ?? { data: 0, error: null })
      : (options.response ?? {
          data: { ok: true, pool_cents: 50_000 },
          error: null,
        })
  );
  const seedCalls = () =>
    rpc.mock.calls.filter((call) => (call as unknown[])[0] === 'fn_mystery_bounty_seed');
  const reportError = vi.fn();
  const from = vi.fn((_relation: string) => query);
  const scheduler = {
    register: vi.fn((_entry: { run: (signal: AbortSignal) => Promise<void> }) => vi.fn()),
  };
  const Subject = new Function(
    'supabase',
    'reportError',
    'console',
    'mysteryPoolCents',
    'poolCentsFromNumeric',
    'shouldActivateMysteryBounty',
    'resolveMysteryBountyProfile',
    'DEFAULT_TOP_BOUNTY_PERCENT',
    'buildInventoryAtUnit',
    'shuffleChests',
    'tournamentUnitCents',
    'tournamentEliminationScheduler',
    'nodeCrypto',
    compiled
  )(
    { from, rpc },
    reportError,
    { log: vi.fn() },
    mysteryPoolCents,
    poolCentsFromNumeric,
    shouldActivateMysteryBounty,
    resolveMysteryBountyProfile,
    DEFAULT_TOP_BOUNTY_PERCENT,
    buildInventoryAtUnit,
    shuffleChests,
    tournamentUnitCents,
    scheduler,
    { randomUUID: () => 'fixture-scheduler-operation' }
  );
  const subject = Object.assign(new Subject(), {
    tournamentId: 'activation-fixture',
    tournamentCache: { is_mystery_bounty: true },
    mysteryBountyStage: 'pending',
    mysteryBountySeeding: false,
    prizePoolFinalized: options.memoryFinalized ?? false,
    allTablesBetweenHands: vi.fn(() => options.betweenHands ?? true),
    holdMysteryActivationBoundary: vi.fn(),
    // Diamond Phase 9: the unit the manager read beside the tournament row;
    // a chip event unless the case says otherwise, null when not read.
    tournamentUnit: vi.fn(() => (options.unit === undefined ? CHIP_UNIT_CENTS : options.unit)),
    broadcast: vi.fn(async () => undefined),
    mysteryTotalEntries: null as number | null,
    readMysteryTotalEntries: vi.fn(async () =>
      options.totalEntries === undefined ? 180 : options.totalEntries
    ),
    readUnrecordedKnockoutCount: vi.fn(async () =>
      options.unrecordedKnockouts === undefined ? 0 : options.unrecordedKnockouts
    ),
  });
  return { subject, rpc, query, from, scheduler, reportError, seedCalls };
}

function schedulerSubject(f: ReturnType<typeof fixture>) {
  const token = { generation: 1, signal: new AbortController().signal };
  Object.assign(f.subject, {
    running: true,
    tournamentLeaseGeneration: 'fixture-generation',
    tournamentCache: { is_mystery_bounty: true, club_id: 'exact-club' },
    tournamentClub: undefined,
    lifecycleEpoch: { current: () => token },
    lifecycleIsCurrent: vi.fn((observed) => f.subject.running && observed === token),
    managerLifecycleDiagnostics: { instanceId: 'fixture-manager' },
    schedulerDiagnosticIds: new WeakMap(),
    eliminationSchedulerJobs: new Set(),
    recordManagerDiagnostic: vi.fn(),
    askForConsolidationIfSpread: vi.fn(),
    getLifecycleDiagnosticSnapshot: vi.fn(),
    declareConsolidationOutstanding: vi.fn(),
  });
  delete f.subject.tournamentUnit;
  let registration: { run: (signal: AbortSignal) => Promise<void> } | undefined;
  f.scheduler.register.mockImplementation((entry) => {
    registration = entry;
    return vi.fn();
  });
  const run = vi.fn(async () => f.subject.maybeActivateMysteryBounty(27));
  f.subject.registerEliminationScheduler(run);
  return { token, run, sweep: () => registration!.run(new AbortController().signal) };
}

describe('an existing sweep recovers an unread club without guessing its asset', () => {
  it.each([
    ['diamonds', 100],
    ['chips', 1],
  ])('recovers a held %s mystery transition after a failed admission read', async (asset, unit) => {
    const f = fixture({ finalized: true });
    const h = schedulerSubject(f);
    const club = { asset, is_platform: true, union_id: null };
    const clubRead = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'temporary club outage' } })
      .mockResolvedValue({ data: club, error: null });
    const clubQuery: any = {
      select: vi.fn(() => clubQuery),
      eq: vi.fn(() => clubQuery),
      maybeSingle: clubRead,
    };
    f.from.mockImplementation((relation: string) => (relation === 'clubs' ? clubQuery : f.query));
    await f.subject.readTournamentClub('exact-club', h.token);
    expect(f.subject.tournamentClub).toBeUndefined();
    expect(await f.subject.maybeActivateMysteryBounty(27)).toBe(true);
    expect(f.seedCalls()).toHaveLength(0);

    await h.sweep();
    expect(clubRead).toHaveBeenCalledTimes(2);
    expect(clubQuery.eq).toHaveBeenLastCalledWith('id', 'exact-club');
    expect(f.subject.tournamentClub).toEqual(club);
    expect(f.subject.tournamentUnit()).toBe(unit);
    expect(f.subject.mysteryBountyStage).toBe('active');
    expect(f.seedCalls()).toHaveLength(1);
    for (const chest of (f.seedCalls()[0] as any)[1].p_chests)
      expect(chest.amount_cents % Math.max(100, Number(unit))).toBe(0);
    await h.sweep();
    expect(clubRead).toHaveBeenCalledTimes(2);
    expect(f.seedCalls()).toHaveLength(1);
  });

  it('retains UNKNOWN on another failed read while the existing sweep still runs', async () => {
    const f = fixture({ finalized: true });
    const h = schedulerSubject(f);
    const clubQuery: any = {
      select: () => clubQuery,
      eq: () => clubQuery,
      maybeSingle: vi.fn(async () => ({ data: null, error: { message: 'still unavailable' } })),
    };
    f.from.mockImplementation((relation: string) => (relation === 'clubs' ? clubQuery : f.query));
    await h.sweep();
    expect(clubQuery.maybeSingle).toHaveBeenCalledOnce();
    expect(h.run).toHaveBeenCalledOnce();
    expect(f.subject.tournamentClub).toBeUndefined();
    expect(f.seedCalls()).toHaveLength(0);
    expect(f.subject.mysteryBountyStage).toBe('pending');
  });

  it.each([
    ['stop', false],
    ['replace', false],
    ['stop', true],
    ['replace', true],
  ])('a delayed club reply cannot mutate or seed after %s (failed=%s)', async (change, failed) => {
    const f = fixture({ finalized: true });
    const h = schedulerSubject(f);
    let answer!: (value: unknown) => void;
    const clubQuery: any = {
      select: () => clubQuery,
      eq: () => clubQuery,
      maybeSingle: vi.fn(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          })
      ),
    };
    f.from.mockImplementation((relation: string) => (relation === 'clubs' ? clubQuery : f.query));
    const sweeping = h.sweep();
    await Promise.resolve();
    expect(clubQuery.maybeSingle).toHaveBeenCalledOnce();
    if (change === 'stop') f.subject.running = false;
    else f.subject.lifecycleIsCurrent.mockReturnValue(false);
    // A retired failure cannot erase a successor's newly established unit either.
    if (failed) f.subject.tournamentClub = { asset: 'chips', is_platform: true, union_id: null };
    const before = f.subject.tournamentClub;
    answer(
      failed
        ? { data: null, error: { message: 'late failed read' } }
        : { data: { asset: 'diamonds', is_platform: true, union_id: null }, error: null }
    );
    await sweeping;
    expect(f.subject.tournamentClub).toBe(before);
    expect(h.run).not.toHaveBeenCalled();
    expect(f.seedCalls()).toHaveLength(0);
  });

  it('does not reread a club whose absent join was already established', async () => {
    const f = fixture({ finalized: true });
    const h = schedulerSubject(f);
    f.subject.tournamentClub = null;
    await h.sweep();
    expect(f.from).not.toHaveBeenCalledWith('clubs');
    expect(f.subject.tournamentUnit()).toBe(CHIP_UNIT_CENTS);
  });
});

describe('mystery activation uses the closed entry pool', () => {
  it('uses the final 21-place ladder instead of a stale 20-place cache', async () => {
    const f = fixture({ finalized: true, paidPlaces: 21 });
    f.subject.tournamentCache.payout_structure = Array.from({ length: 20 }, (_, i) => ({
      place: i + 1,
    }));
    // The durable finalized ladder is the authority, even with nonempty memory.
    await f.subject.maybeActivateMysteryBounty(21);
    expect(f.seedCalls()).toHaveLength(1);
    expect(f.seedCalls()[0]).toEqual([
      'fn_mystery_bounty_seed',
      expect.objectContaining({
        p_players_remaining: 21,
        p_chests: expect.any(Array),
      }),
    ]);
    expect(f.seedCalls()[0]).toHaveProperty('1.p_chests.length', 20);
  });

  it('arms the held boundary when a fresh count reaches the money during another hand', async () => {
    const f = fixture({ finalized: true, betweenHands: false, paidPlaces: 21 });
    expect(await f.subject.maybeActivateMysteryBounty(21)).toBe(true);
    expect(f.subject.holdMysteryActivationBoundary).toHaveBeenCalledOnce();
    expect(f.seedCalls()).toHaveLength(0);
  });

  it('keeps a held activation unresolved after an unknown seed outcome', async () => {
    const f = fixture({ finalized: true, response: { data: null, error: { message: 'timeout' } } });
    expect(await f.subject.maybeActivateMysteryBounty(21)).toBe(true);
    expect(f.subject.holdMysteryActivationBoundary).toHaveBeenCalledOnce();
    expect(f.subject.mysteryBountyStage).toBe('pending');
    expect(f.subject.broadcast).not.toHaveBeenCalled();
  });

  it('does not seed while entry is open even when every table is parked for a break', async () => {
    const f = fixture();
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.query.maybeSingle).toHaveBeenCalledOnce();
    expect(f.subject.allTablesBetweenHands).toHaveBeenCalledOnce();
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.subject.broadcast).not.toHaveBeenCalled();
    expect(f.subject.mysteryBountyStage).toBe('pending');
  });

  it('does not announce activation when stale finalized memory meets a database refusal', async () => {
    const f = fixture({
      memoryFinalized: true,
      response: { data: { ok: false, reason: 'entry_still_open' }, error: null },
    });
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.seedCalls()).toHaveLength(1);
    expect(f.subject.mysteryBountyStage).toBe('pending');
    expect(f.subject.broadcast).not.toHaveBeenCalled();
    expect(f.subject.mysteryBountySeeding).toBe(false);
  });

  it('keeps the closed pool pending while a table still has a hand in progress', async () => {
    const f = fixture({ finalized: true, betweenHands: false });
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.subject.broadcast).not.toHaveBeenCalled();
    expect(f.subject.mysteryBountyStage).toBe('pending');
  });

  it('builds the configured complete inventory and adopts one accepted seed', async () => {
    const f = fixture({ finalized: true });
    await f.subject.maybeActivateMysteryBounty(27);
    const [name, args] = f.seedCalls()[0] as unknown as [
      string,
      {
        p_tournament_id: string;
        p_players_remaining: number;
        p_chests: { amount_cents: number; seq: number }[];
      },
    ];
    expect(name).toBe('fn_mystery_bounty_seed');
    expect(args.p_tournament_id).toBe('activation-fixture');
    expect(args.p_players_remaining).toBe(27);
    expect(args.p_chests).toHaveLength(26);
    expect(new Set(args.p_chests.map((c) => c.seq)).size).toBe(26);
    expect(args.p_chests.reduce((sum, c) => sum + c.amount_cents, 0)).toBe(50_000);
    expect(f.subject.mysteryBountyStage).toBe('active');
    expect(f.subject.broadcast).toHaveBeenCalledWith('mystery_bounty_activated', {
      poolCents: 50_000,
      chests: 26,
      profile: 'classic',
    });
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.seedCalls()).toHaveLength(1);
    expect(f.subject.broadcast).toHaveBeenCalledOnce();
  });

  it('keeps unrecorded pre-activation heads out of the inventory it builds (20260911094503)', async () => {
    // 100,000c pool, 50/50: the mystery half is 50,000c. 60,000c of heads are
    // earned but not yet recorded, so only 40,000c can go into the chests -
    // exactly what fn_mystery_bounty_seed will accept.
    const f = fixture({ finalized: true, unrecorded: { data: 60_000, error: null } });
    await f.subject.maybeActivateMysteryBounty(27);
    const [name, args] = f.seedCalls()[0] as unknown as [
      string,
      { p_chests: { amount_cents: number }[] },
    ];
    expect(name).toBe('fn_mystery_bounty_seed');
    expect(args.p_chests.reduce((sum, c) => sum + c.amount_cents, 0)).toBe(40_000);
    const unrecordedAt = f.rpc.mock.calls.findIndex(
      (call) => (call as unknown[])[0] === 'fn_mystery_bounty_unrecorded_head_cents'
    );
    const seedAt = f.rpc.mock.calls.findIndex(
      (call) => (call as unknown[])[0] === 'fn_mystery_bounty_seed'
    );
    expect(unrecordedAt).toBeGreaterThan(-1);
    expect(unrecordedAt).toBeLessThan(seedAt);
  });

  it('an unreadable unrecorded-head figure is not zero: it waits and seeds nothing', async () => {
    for (const unrecorded of [
      { data: null, error: { message: 'connection interrupted' } },
      { data: 12.5, error: null },
      { data: null, error: null },
      { data: -1, error: null },
    ]) {
      const f = fixture({ finalized: true, unrecorded });
      await f.subject.maybeActivateMysteryBounty(27);
      expect(f.seedCalls()).toHaveLength(0);
      expect(f.subject.mysteryBountyStage).toBe('pending');
      expect(f.subject.mysteryBountySeeding).toBe(false);
      expect(f.subject.broadcast).not.toHaveBeenCalled();
      expect(f.reportError).toHaveBeenCalledWith(
        expect.anything(),
        'Tournament.mystery_bounty_unrecorded_heads_unreadable'
      );
    }
  });

  it('leaves activation retryable after an RPC error without broadcasting success', async () => {
    const f = fixture({
      finalized: true,
      response: { data: null, error: { message: 'connection interrupted' } },
    });
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.subject.mysteryBountyStage).toBe('pending');
    expect(f.subject.mysteryBountySeeding).toBe(false);
    expect(f.subject.broadcast).not.toHaveBeenCalled();
    expect(f.reportError).toHaveBeenCalledOnce();
  });

  it('seeds a Diamond event with chests in whole Diamonds (Diamond Phase 9)', async () => {
    const f = fixture({ finalized: true, unit: DIAMOND_UNIT_CENTS });
    await f.subject.maybeActivateMysteryBounty(27);
    const [name, args] = f.seedCalls()[0] as unknown as [
      string,
      { p_chests: { amount_cents: number }[] },
    ];
    expect(name).toBe('fn_mystery_bounty_seed');
    expect(args.p_chests).toHaveLength(26);
    expect(args.p_chests.reduce((sum, c) => sum + c.amount_cents, 0)).toBe(50_000);
    for (const c of args.p_chests) {
      expect(c.amount_cents % DIAMOND_UNIT_CENTS).toBe(0);
      expect(c.amount_cents).toBeGreaterThanOrEqual(DIAMOND_UNIT_CENTS);
    }
    expect(f.subject.mysteryBountyStage).toBe('active');
  });

  it('seeds a chip event with chests in whole chips, never fractions (Dan 2026-10-22)', async () => {
    const f = fixture({ finalized: true });
    await f.subject.maybeActivateMysteryBounty(27);
    const [, args] = f.seedCalls()[0] as unknown as [
      string,
      { p_chests: { amount_cents: number }[] },
    ];
    expect(args.p_chests).toHaveLength(26);
    expect(args.p_chests.reduce((sum, c) => sum + c.amount_cents, 0)).toBe(50_000);
    for (const c of args.p_chests) {
      expect(c.amount_cents % 100).toBe(0);
      expect(c.amount_cents).toBeGreaterThanOrEqual(100);
    }
  });

  it('does not seed an event whose unit it has not read (Diamond Phase 9)', async () => {
    const f = fixture({ finalized: true, unit: null });
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.seedCalls()).toHaveLength(0);
    expect(f.subject.mysteryBountyStage).toBe('pending');
    expect(f.subject.broadcast).not.toHaveBeenCalled();
    expect(f.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.mystery_bounty_unit_unknown'
    );
  });

  it('measures a percent_field threshold against total entries, not the drained current_players', async () => {
    // 180 entries, chests open at the last 20% = 36 players. 27 remain, and
    // current_players has drained to 27: the old read compared 27 with 20% of
    // 27 (6) and never opened.
    const f = fixture({
      finalized: true,
      mode: 'percent_field',
      modeValue: 20,
      currentPlayers: 27,
      totalEntries: 180,
    });
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.subject.readMysteryTotalEntries).toHaveBeenCalledOnce();
    expect(f.seedCalls()).toHaveLength(1);
    expect(f.subject.mysteryBountyStage).toBe('active');
    expect(f.subject.mysteryTotalEntries).toBe(180);
  });

  it('does not open a percent_field event above its threshold', async () => {
    const f = fixture({
      finalized: true,
      mode: 'percent_field',
      modeValue: 10,
      currentPlayers: 27,
      totalEntries: 180,
    });
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.seedCalls()).toHaveLength(0);
    expect(f.subject.mysteryBountyStage).toBe('pending');
  });

  it('an unreadable entry count is not the survivors: percent_field waits and seeds nothing', async () => {
    const f = fixture({
      finalized: true,
      mode: 'percent_field',
      modeValue: 20,
      currentPlayers: 27,
      totalEntries: null,
    });
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.seedCalls()).toHaveLength(0);
    expect(f.subject.mysteryBountyStage).toBe('pending');
  });

  /* Dan, 2026-10-05: "MYSTERY BOUNTY OF 10 OR FEWER DON'T GET CHESTS". The
     sweep reads the closed entry count in EVERY mode now, and a field of 10
     or fewer seeds nothing however the threshold reads. */
  it('a mystery bounty of 10 or fewer entries seeds nothing, in every mode', async () => {
    for (const [mode, modeValue] of [
      ['at_the_money', null],
      ['percent_field', 100],
      ['player_count', 9],
    ] as const) {
      const f = fixture({ finalized: true, mode, modeValue, currentPlayers: 3, totalEntries: 10 });
      await f.subject.maybeActivateMysteryBounty(3);
      expect(f.subject.readMysteryTotalEntries).toHaveBeenCalledOnce();
      expect(f.seedCalls()).toHaveLength(0);
      expect(f.subject.mysteryBountyStage).toBe('pending');
      expect(f.subject.broadcast).not.toHaveBeenCalled();
    }
  });

  it('11 entries still opens at the money', async () => {
    const f = fixture({ finalized: true, currentPlayers: 3, totalEntries: 11 });
    await f.subject.maybeActivateMysteryBounty(3);
    expect(f.seedCalls()).toHaveLength(1);
    expect(f.subject.mysteryBountyStage).toBe('active');
  });

  it('an unreadable entry count waits at the money too', async () => {
    const f = fixture({ finalized: true, currentPlayers: 27, totalEntries: null });
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.seedCalls()).toHaveLength(0);
    expect(f.subject.mysteryBountyStage).toBe('pending');
  });

  it('draws no chest for a bust already played but not yet recorded (b5102d84)', async () => {
    // 27 still recorded as playing, 2 of them already busted in a committed
    // hand and paid flat from the regular half: 25 can still be knocked out
    // for a chest, so 24 chests, and the seed is told 25.
    const f = fixture({ finalized: true, unrecordedKnockouts: 2 });
    await f.subject.maybeActivateMysteryBounty(27);
    const [, args] = f.seedCalls()[0] as unknown as [
      string,
      { p_players_remaining: number; p_chests: unknown[] },
    ];
    expect(args.p_players_remaining).toBe(25);
    expect(args.p_chests).toHaveLength(24);
    expect(f.subject.broadcast).toHaveBeenCalledWith(
      'mystery_bounty_activated',
      expect.objectContaining({ chests: 24 })
    );
  });

  it('an unreadable unrecorded-bust count waits and seeds nothing', async () => {
    const f = fixture({ finalized: true, unrecordedKnockouts: null });
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.seedCalls()).toHaveLength(0);
    expect(f.subject.mysteryBountyStage).toBe('pending');
    expect(f.subject.mysteryBountySeeding).toBe(false);
  });

  it('adopts an already stored active stage without another seed or announcement', async () => {
    const f = fixture({ finalized: true, stage: 'active' });
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.subject.mysteryBountyStage).toBe('active');
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.subject.broadcast).not.toHaveBeenCalled();
  });
});
