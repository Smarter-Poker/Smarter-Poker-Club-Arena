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
import { CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS } from './tournamentUnit.js';

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
const compiled = ts.transpileModule(
  `${count.getText(ast)}\nclass Subject { ${method.getText(ast)} }\nreturn Subject;`,
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
    mystery_bounty_activation: 'at_the_money',
    mystery_bounty_activation_value: null,
    mystery_bounty_top_percent: 30,
    payout_structure: Array.from({ length: 27 }, (_, i) => ({ place: i + 1, percentage: 1 })),
    current_players: 180,
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
    compiled
  )(
    { from: vi.fn(() => query), rpc },
    reportError,
    { log: vi.fn() },
    mysteryPoolCents,
    poolCentsFromNumeric,
    shouldActivateMysteryBounty,
    resolveMysteryBountyProfile,
    DEFAULT_TOP_BOUNTY_PERCENT,
    buildInventoryAtUnit,
    shuffleChests
  );
  const subject = Object.assign(new Subject(), {
    tournamentId: 'activation-fixture',
    tournamentCache: { is_mystery_bounty: true },
    mysteryBountyStage: 'pending',
    mysteryBountySeeding: false,
    prizePoolFinalized: options.memoryFinalized ?? false,
    allTablesBetweenHands: vi.fn(() => options.betweenHands ?? true),
    // Diamond Phase 9: the unit the manager read beside the tournament row;
    // a chip event unless the case says otherwise, null when not read.
    tournamentUnit: vi.fn(() => (options.unit === undefined ? CHIP_UNIT_CENTS : options.unit)),
    broadcast: vi.fn(async () => undefined),
  });
  return { subject, rpc, query, reportError, seedCalls };
}

describe('mystery activation uses the closed entry pool', () => {
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

  it('adopts an already stored active stage without another seed or announcement', async () => {
    const f = fixture({ finalized: true, stage: 'active' });
    await f.subject.maybeActivateMysteryBounty(27);
    expect(f.subject.mysteryBountyStage).toBe('active');
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.subject.broadcast).not.toHaveBeenCalled();
  });
});
