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
    const args = rpc.mock.calls[0][1] as any;
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
