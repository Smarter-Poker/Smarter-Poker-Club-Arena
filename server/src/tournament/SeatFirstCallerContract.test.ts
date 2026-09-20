import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TournamentRecurringService } from '../services/TournamentRecurringService.js';
import { supabase } from '../services/supabase.js';
import { HEADS_UP_BLIND_STRUCTURE, HEADS_UP_PAYOUTS } from '../config/headsUpSpec.js';

const baseline = JSON.parse(
  readFileSync(
    new URL(
      '../../../scripts/dev/fixtures/seat-first-caller-contract/baseline.json',
      import.meta.url
    ),
    'utf8'
  )
);
const body = baseline.definition.match(/AS \$function\$([\s\S]*)\$function\$/)[1];
const keyList = body.match(/WHERE supplied\.key NOT IN \(([\s\S]*?)\)\s*\)/)[1];
const allowed = new Set([...keyList.matchAll(/'([^']+)'/g)].map((m) => m[1]));
const captured: Array<{ label: string; config: Record<string, unknown> }> = [];
afterAll(() => {
  if (process.env.CA_SEAT_FIRST_CAPTURE_PATH)
    writeFileSync(process.env.CA_SEAT_FIRST_CAPTURE_PATH, JSON.stringify(captured, null, 2) + '\n');
  else {
    const native = JSON.parse(
      readFileSync(
        new URL(
          '../../../scripts/dev/fixtures/seat-first-caller-contract/actual-caller-payloads.json',
          import.meta.url
        ),
        'utf8'
      )
    );
    const normalize = (rows: typeof captured) =>
      rows.map((row) => ({ ...row, config: { ...row.config, start_time: '<runtime>' } }));
    expect(normalize(captured)).toEqual(normalize(native));
  }
});
afterEach(() => vi.restoreAllMocks());
const club = 'c5000000-0000-4000-8000-000000000001';
const target = 'c5000000-0000-4000-8000-000000000002';
function fixture() {
  const service = new TournamentRecurringService() as any;
  vi.spyOn(service, 'seedOpenSeatTable').mockResolvedValue('c5000000-0000-4000-8000-000000000003');
  vi.spyOn(service, 'registerHorses').mockResolvedValue(0);
  const from = { update: vi.fn(() => from), eq: vi.fn(async () => ({ error: null })) };
  vi.spyOn(supabase, 'from').mockReturnValue(from as never);
  const rpc = vi
    .spyOn(supabase as any, 'rpc')
    .mockImplementation(async (name: unknown, args: any) => {
      if (name === 'fn_ensure_scheduled_mtt_satellite') {
        const config = args.p_config.legacy_config;
        const extras = Object.keys(config).filter((key) => !allowed.has(key));
        if (extras.length)
          return { data: null, error: { message: 'SEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY' } };
        return {
          error: null,
          data: {
            ok: true,
            outcome: 'created',
            tournament_id: target,
            target_id: config.satellite_target_id,
            club_id: config.club_id,
            union_id: config.union_id,
            format_contract: 'seat-first-satellite-v1',
            table_id: 'c5000000-0000-4000-8000-000000000003',
            tournament: { ...config, id: target, format_contract: 'seat-first-satellite-v1' },
          },
        };
      }
      if (name !== 'fn_create_seat_first_game_atomic') throw new Error(`Unexpected RPC ${name}`);
      const extra = Object.keys(args.p_config).filter((key) => !allowed.has(key));
      return extra.length
        ? { data: null, error: { message: 'SEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY' } }
        : ({
            data: {
              ok: true,
              tournament: { ...args.p_config, id: args.p_tournament_id },
              table_id: 'c5000000-0000-4000-8000-000000000003',
            },
            error: null,
          } as any);
    });
  return { service, rpc };
}
const cases = ['createSNG', 'createSatelliteHeadsUp', 'createSpin'].flatMap((method) =>
  [false, true].flatMap((union) => [300, 1000].map((stack) => ({ method, union, stack })))
);
describe('actual seat-first callers match the installed atomic creator contract', () => {
  it('pins the complete captured SQL body used for its key contract', () => {
    expect(createHash('md5').update(body).digest('hex')).toBe(baseline.source_md5);
    expect(baseline.source_md5).toBe('b40dd95b7a87019070a8abf0fcc4fff3');
    expect(allowed.has('payout_percent')).toBe(false);
  });
  it.each(cases)('$method / union=$union / stack=$stack', async ({ method, union, stack }) => {
    const { service, rpc } = fixture();
    const owner = {
      clubId: club,
      unionId: union ? 'c5000000-0000-4000-8000-000000000004' : null,
      kind: union ? 'union' : 'club',
      maxStake: 1000,
    };
    const config = {
      name: `Caller ${method} ${union} ${stack}`,
      gameVariant: 'nlh',
      buyIn: 20,
      startingStack: stack,
      maxPlayers: method === 'createSpin' ? 3 : 2,
      minPlayers: method === 'createSpin' ? 3 : 2,
      horsesToRegister: 0,
      blindStructure: HEADS_UP_BLIND_STRUCTURE,
      payoutStructure: HEADS_UP_PAYOUTS,
      payoutPercent: 20,
      targetId: target,
      targetName: 'Target MTT',
      ticketCost: 30,
    };
    const result = await service[method](config, owner);
    expect(rpc).toHaveBeenCalledOnce();
    const sent = rpc.mock.calls[0][1] as any;
    const args =
      method === 'createSatelliteHeadsUp'
        ? { p_config: sent.p_config.legacy_config, p_tournament_id: target }
        : sent;
    const extras = Object.keys(args.p_config).filter((key) => !allowed.has(key));
    expect(extras).toEqual([]);
    expect(result.tournamentId).toBe(args.p_tournament_id);
    expect(service.seedOpenSeatTable).toHaveBeenCalledOnce();
    expect(args.p_config).toMatchObject({
      club_id: club,
      union_id: owner.unionId,
      starting_chips: stack,
    });
    expect(args.p_config).not.toHaveProperty('payout_percent');
    if (method === 'createSatelliteHeadsUp')
      expect(args.p_config).toMatchObject({
        satellite_target_id: target,
        satellite_seats: 1,
        payout_structure: HEADS_UP_PAYOUTS,
      });
    if (method === 'createSpin')
      expect(args.p_config).toMatchObject({
        spin_multiplier: null,
        spin_locked_tiers: null,
        max_players: 3,
      });
    captured.push({ label: config.name, config: args.p_config });
  });
  it('does not seed after an actual creator refusal', async () => {
    const { service, rpc } = fixture();
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'SEAT_FIRST_CREATE_INVALID_CONFIG' },
    } as never);
    const result = await service.createSNG({
      name: 'Refused',
      gameVariant: 'nlh',
      buyIn: 5,
      maxPlayers: 2,
      minPlayers: 2,
      startingStack: 300,
      blindStructure: HEADS_UP_BLIND_STRUCTURE,
      payoutStructure: HEADS_UP_PAYOUTS,
    });
    expect(result.tournamentId).toBeNull();
    expect(service.seedOpenSeatTable).not.toHaveBeenCalled();
  });
  it('retains selected paid depth for the existing field SNG path', async () => {
    const { service, rpc } = fixture();
    const rows: unknown[] = [];
    const chain = {
      insert: (row: unknown) => {
        rows.push(row);
        return chain;
      },
      select: () => chain,
      maybeSingle: async () => ({ data: { id: target }, error: null }),
      update: () => chain,
      eq: async () => ({ error: null }),
    };
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    const result = await service.createSNG({
      name: 'Field',
      gameVariant: 'nlh',
      buyIn: 5,
      maxPlayers: 6,
      minPlayers: 3,
      startingStack: 3000,
      horsesToRegister: 0,
      payoutPercent: 20,
      blindStructure: HEADS_UP_BLIND_STRUCTURE,
      payoutStructure: HEADS_UP_PAYOUTS,
    });
    expect(result.tournamentId).toBe(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ payout_percent: 20 });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('dual satellite creator consumes the authoritative purchased format', () => {
  const owner = { clubId: club, unionId: null, kind: 'club', maxStake: 1000 };
  const config = {
    name: 'Target Satellite Heads-Up',
    gameVariant: 'nlh',
    buyIn: 20,
    startingStack: 300,
    maxPlayers: 2,
    minPlayers: 2,
    horsesToRegister: 0,
    blindStructure: HEADS_UP_BLIND_STRUCTURE,
    payoutStructure: HEADS_UP_PAYOUTS,
    targetId: target,
    targetName: 'Target',
    ticketCost: 30,
  };
  it('continues an existing legacy satellite using its confirmed historical target pointer', async () => {
    const { service, rpc } = fixture();
    rpc.mockImplementation(async (_name: any, args: any) => ({
      error: null,
      data: {
        ok: true,
        outcome: 'existing_active',
        tournament_id: target,
        target_id: target,
        club_id: club,
        union_id: null,
        format_contract: 'seat-first-satellite-v1',
        table_id: club,
        tournament: {
          ...args.p_config.legacy_config,
          id: target,
          satellite_target_id: null,
          satellite_target: target,
          format_contract: 'seat-first-satellite-v1',
        },
      },
    }));
    expect(await service.createSatelliteHeadsUp(config, owner)).toEqual({
      tournamentId: target,
      registered: 0,
      created: false,
    });
    expect(service.seedOpenSeatTable).toHaveBeenCalledWith(
      expect.objectContaining({ id: target, format_contract: 'seat-first-satellite-v1' }),
      2,
      club
    );
  });
  it.each(['created', 'existing_active'])(
    'accepts a scheduled %s receipt without seeding a HU table',
    async (outcome) => {
      const { service, rpc } = fixture();
      rpc.mockImplementation(async (_name: any, args: any) => {
        const row = args.p_config.scheduled_config;
        return {
          error: null,
          data: {
            ok: true,
            outcome,
            tournament_id: target,
            target_id: target,
            club_id: club,
            union_id: null,
            format_contract: 'mtt-v2',
            table_id: null,
            tournament: { ...row, id: target, format_contract: 'mtt-v2' },
          },
        };
      });
      const result = await service.createSatelliteHeadsUp(config, owner);
      expect(rpc).toHaveBeenCalledOnce();
      expect(rpc.mock.calls[0][0]).toBe('fn_ensure_scheduled_mtt_satellite');
      const envelope = (rpc.mock.calls[0][1] as any).p_config;
      expect(envelope.legacy_config).toMatchObject({
        max_players: 2,
        min_players: 2,
        table_size: 2,
        starting_chips: 300,
        buy_in_fee: 1,
      });
      expect(envelope.scheduled_config).toMatchObject({
        max_players: null,
        min_players: 3,
        table_size: 9,
        starting_chips: 10000,
        buy_in_amount: 13.5,
        buy_in_fee: 1.5,
        synchronized_breaks: true,
      });
      expect(envelope.scheduled_config.blind_structure.length).toBeGreaterThan(20);
      expect(result).toEqual({
        tournamentId: target,
        registered: 0,
        created: outcome === 'created',
      });
      expect(service.seedOpenSeatTable).not.toHaveBeenCalled();
    }
  );
  it.each([
    'missing-format',
    'parent-mismatch',
    'wrong-target',
    'conflicting-parent-target',
    'wrong-owner',
    'scheduled-chair',
    'missing-legacy-chair',
  ])('refuses %s without using the other creator as fallback', async (fault) => {
    const { service, rpc } = fixture();
    rpc.mockImplementation(async (_name: any, args: any) => {
      const row = args.p_config.scheduled_config;
      const receipt: any = {
        ok: true,
        outcome: 'created',
        tournament_id: target,
        target_id: target,
        club_id: club,
        union_id: null,
        format_contract: 'mtt-v2',
        table_id: null,
        tournament: { ...row, id: target, format_contract: 'mtt-v2' },
      };
      if (fault === 'missing-format') delete receipt.format_contract;
      if (fault === 'parent-mismatch')
        receipt.tournament.format_contract = 'seat-first-satellite-v1';
      if (fault === 'wrong-target') receipt.target_id = club;
      if (fault === 'conflicting-parent-target') receipt.tournament.satellite_target = club;
      if (fault === 'wrong-owner') receipt.tournament.club_id = target;
      if (fault === 'scheduled-chair') receipt.table_id = club;
      if (fault === 'missing-legacy-chair') {
        receipt.format_contract = 'seat-first-satellite-v1';
        receipt.tournament = {
          ...args.p_config.legacy_config,
          id: target,
          format_contract: 'seat-first-satellite-v1',
        };
      }
      return { error: null, data: receipt };
    });
    expect((await service.createSatelliteHeadsUp(config, owner)).tournamentId).toBeNull();
    expect(rpc).toHaveBeenCalledOnce();
    expect(service.seedOpenSeatTable).not.toHaveBeenCalled();
  });
});

describe('recurring satellite selection follows the admitted creation horizon', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  const owner = { clubId: club, unionId: null, kind: 'club', maxStake: 1000 };
  const targets = [1, 2, 3, 4].map((n) => ({
    id: `c5000000-0000-4000-8000-00000000001${n}`,
    name: `Target ${n}`,
    format_contract: 'mtt-v1',
    satellite_target_id: null,
    satellite_target: null,
    start_time: new Date(now + (n === 4 ? 4 : 1) * 60 * 60_000).toISOString(),
    buy_in_amount: (5 - n) * 90,
    buy_in_fee: (5 - n) * 10,
    variant: 'freezeout',
    max_players: 200,
    game_type: 'NLH',
    tournament_type: 'MTT',
    is_bounty: false,
    is_pko: false,
    is_mystery_bounty: false,
    is_premium_spin: false,
  }));

  function board(abi: string) {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { service, rpc } = fixture();
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      is: vi.fn(() => query),
      gt: vi.fn(() => query),
      lt: vi.fn(() => query),
      gte: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (resolve: any) => Promise.resolve({ data: targets, error: null }).then(resolve),
    };
    vi.mocked(supabase.from).mockReturnValue(query);
    rpc.mockImplementation(async (name: any, args: any) => {
      if (name === 'fn_ca_tournament_admission_snapshot') {
        return {
          error: null,
          data: {
            ok: true,
            admission_abi: abi,
            entries: targets.map((row) => ({
              tournament_id: row.id,
              format_contract: row.format_contract,
              effective_max_players: abi === 'unlimited-mtt-v2' ? null : row.max_players,
            })),
          },
        };
      }
      if (name !== 'fn_ensure_scheduled_mtt_satellite') throw new Error(`Unexpected RPC ${name}`);
      const legacy = abi === 'legacy-capacity-v1';
      const row = args.p_config[legacy ? 'legacy_config' : 'scheduled_config'];
      const parent = targets.find((t) => t.id === row.satellite_target_id)!;
      if (Date.parse(parent.start_time) - now < (legacy ? 30 : 180) * 60_000)
        return { data: null, error: { message: 'SATELLITE_CREATE_TARGET_UNAVAILABLE' } };
      const format = legacy ? 'seat-first-satellite-v1' : 'mtt-v2';
      return {
        error: null,
        data: {
          ok: true,
          outcome: 'created',
          tournament_id: target,
          target_id: parent.id,
          club_id: club,
          union_id: null,
          format_contract: format,
          table_id: legacy ? club : null,
          tournament: { ...row, id: target, format_contract: format },
        },
      };
    });
    return { service, rpc };
  }

  it('selects a qualified future target before near-term expensive targets consume the board slots', async () => {
    const { service, rpc } = board('unlimited-mtt-v2');
    await service.ensureSatelliteHeadsUps(owner, 3);
    const creations = rpc.mock.calls.filter(
      ([name]) => name === 'fn_ensure_scheduled_mtt_satellite'
    );
    expect(creations).toHaveLength(1);
    expect((creations[0][1] as any).p_config.scheduled_config.satellite_target_id).toBe(
      targets[3].id
    );
    expect(rpc).toHaveBeenCalledWith('fn_ca_tournament_admission_snapshot', {
      p_tournament_ids: targets.map((row) => row.id),
    });
    expect(service.seedOpenSeatTable).not.toHaveBeenCalled();
  });

  it('preserves the thirty-minute legacy board and real HU receipt seeding', async () => {
    const { service, rpc } = board('legacy-capacity-v1');
    await service.ensureSatelliteHeadsUps(owner, 3);
    const creations = rpc.mock.calls.filter(
      ([name]) => name === 'fn_ensure_scheduled_mtt_satellite'
    );
    expect(creations).toHaveLength(3);
    expect(
      creations.map(([, args]) => (args as any).p_config.legacy_config.satellite_target_id)
    ).toEqual(targets.slice(0, 3).map((row) => row.id));
    expect(service.seedOpenSeatTable).toHaveBeenCalledTimes(3);
  });

  it('does not create from an unknown admission snapshot', async () => {
    const { service, rpc } = board('unknown');
    await service.ensureSatelliteHeadsUps(owner, 3);
    expect(rpc.mock.calls.filter(([name]) => name === 'fn_ensure_scheduled_mtt_satellite')).toEqual(
      []
    );
    expect(service.seedOpenSeatTable).not.toHaveBeenCalled();
  });
});
