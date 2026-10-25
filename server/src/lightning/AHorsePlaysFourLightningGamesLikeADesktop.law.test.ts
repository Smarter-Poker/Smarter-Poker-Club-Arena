/**
 * A HORSE PLAYS FOUR LIGHTNING GAMES, LIKE A DESKTOP (Dan 2026-10-24,
 * verbatim: "SEATING SHOULD BE DONE ACCORDINGLY TO HOW IT WAS ALWAYS DONE.
 * 4 GAMES MAX.").
 *
 * Measured 2026-10-24: 22 horses sat in 3 or 4 Lightning pools, but the
 * matcher held them MULTI_TABLE_LIMIT, because no client ever reported a
 * horse's device class and fn_lightning_player_legality reads a missing class
 * as the narrowest one (mobile, 2 live Lightning hands). Their held time was
 * 31% of all recorded Lightning waiting.
 *
 * A horse's input device is the engine (CLAUDE.md 10.5). The engine now says
 * what a browser's `?p=` says, and it says the desktop class: the same limit a
 * desktop player has (4), never wider. The fleet's seating source already
 * stops at four games (MAX_TABLES_PER_HORSE, CONCURRENT_GAME_LIMIT and the
 * database's fn_enforce_four_table_limit), so a horse is seated in at most
 * four Lightning games and is allowed to play every one of them. The human
 * device limits (desktop 4, tablet 3, mobile 2) are untouched.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  maintenanceSupabase: {},
}));
const { ENGINE_INPUT_DEVICE_PLATFORM, LightningPresence } = await import('./LightningPresence.js');
const { CONCURRENT_GAME_LIMIT } = await import('../services/HorseGameLoad.js');

const CLUSTER = '0c0c0c0c-0000-4000-8000-0000000000aa';
const OTHER_CLUSTER = '0c0c0c0c-0000-4000-8000-0000000000bb';
const HUMAN = '0c0c0c0c-0000-4000-8000-000000000001';
const HORSE = '0c0c0c0c-0000-4000-8000-000000000002';
const engines: any[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.preciseTimer?.dispose?.();
});

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** The client's per-device limits, read from the one place they are declared. */
function clientLimits(): Record<string, number> {
  const src = read('../../../src/lightning/lightningCapabilities.ts');
  const m = src.match(
    /LIGHTNING_MULTI_TABLE_LIMIT_DEFAULTS[^=]*=\s*Object\.freeze\(\{\s*desktop:\s*(\d+),\s*tablet:\s*(\d+),\s*mobile:\s*(\d+)\s*\}\)/
  );
  expect(m, 'LIGHTNING_MULTI_TABLE_LIMIT_DEFAULTS must stay readable').toBeTruthy();
  return { desktop: Number(m![1]), tablet: Number(m![2]), mobile: Number(m![3]) };
}

describe('a horse plays four Lightning games, like a desktop', () => {
  it('the engine, as a horse input device, reports the desktop class', () => {
    expect(ENGINE_INPUT_DEVICE_PLATFORM).toBe('desktop');
  });

  it('the desktop limit is four games, and the human limits are unchanged', () => {
    expect(clientLimits()).toEqual({ desktop: 4, tablet: 3, mobile: 2 });
  });

  it('the fleet seats a horse in at most four games at the source', () => {
    expect(CONCURRENT_GAME_LIMIT).toBe(4);
    const fleet = read('../services/HorseFleetManager.ts');
    expect(fleet).toMatch(/\nconst MAX_TABLES_PER_HORSE = 4;\n/);
  });

  it("an anchor engine reports a horse's device class and never a human's", async () => {
    const { ServerTableEngine } = await import('../engine/ServerTableEngine.js');
    const e = new ServerTableEngine('0c0c0c0c-0000-4000-8000-0000000000cc') as any;
    engines.push(e);
    e.tableInfo = { id: e.tableId, game_type: 'cash', cluster_id: CLUSTER };
    e.seatedPlayers = [
      { user_id: HUMAN, seat_number: 1, stack: 100, is_horse: false },
      { user_id: HORSE, seat_number: 2, stack: 100, is_horse: true },
    ];
    for (const id of [HUMAN, HORSE]) e.disconnectEngine.registerPlayer(e.tableId, id);
    const players = e.lightningPresenceReport().players;
    expect(players.find((p: any) => p.userId === HORSE)).toEqual({
      userId: HORSE,
      presence: 'connected',
      platform: 'desktop',
    });
    // A human's class only ever comes from their own client's room.
    expect(players.find((p: any) => p.userId === HUMAN)).not.toHaveProperty('platform');
  });

  it('the matcher feed carries the desktop class for a horse in every Cluster', () => {
    const presence = new LightningPresence(() => [
      {
        tableId: 'anchor-a',
        clusterId: CLUSTER,
        players: [
          { userId: HORSE, presence: 'connected', platform: ENGINE_INPUT_DEVICE_PLATFORM },
          { userId: HUMAN, presence: 'connected' },
        ],
      },
      {
        tableId: 'anchor-b',
        clusterId: OTHER_CLUSTER,
        players: [{ userId: HORSE, presence: 'connected', platform: ENGINE_INPUT_DEVICE_PLATFORM }],
      },
    ]);
    const snap = presence.snapshot(CLUSTER);
    expect(snap.platforms[HORSE]).toBe('desktop');
    // No report for the human: the SQL default (mobile) still applies to them.
    expect(snap.platforms).not.toHaveProperty(HUMAN);
  });

  it('a real client on the horse account still narrows it: the narrower report wins', () => {
    const presence = new LightningPresence(() => [
      {
        tableId: 'anchor-a',
        clusterId: CLUSTER,
        players: [{ userId: HORSE, presence: 'connected', platform: ENGINE_INPUT_DEVICE_PLATFORM }],
      },
      {
        tableId: 'room-of-the-horse-account',
        clusterId: CLUSTER,
        players: [{ userId: HORSE, presence: 'connected', platform: 'mobile' }],
      },
    ]);
    expect(presence.snapshot(CLUSTER).platforms[HORSE]).toBe('mobile');
  });
});
