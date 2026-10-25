/**
 * LAW: A NEW PLAYER'S FIRST LIGHTNING HAND IS THE BIG BLIND (Dan, 2026-10-24).
 * ═══════════════════════════════════════════════════════════════════════════
 * Dan, verbatim: "NEW PLAYERS SHOULD ALWAYS BE BB FIRST."
 *
 * Read from production before the fix: of 359 new pool slots in three hours,
 * 337 were the big blind in their first hand, 18 the small blind and 4 held no
 * blind. The first-entry rule was off by default ('any_seat'), "newcomer" meant
 * "no blind-ledger row in the Cluster, ever", and even when on the rule held a
 * newcomer only while it cost the pass no hand. Every exception was a pass
 * where two or more never-dealt players were formed together.
 *
 * The rule now, in the live SQL plan (fn_lightning_match_plan, migration
 * 20261024195059) and its TypeScript port (LightningMatcherModel), line for
 * line:
 *
 *   - a NEWCOMER is a pool slot that has never been the big blind
 *     (lightning_pool_slot.last_bb_at IS NULL / `lastBbAtMs === null`);
 *   - a newcomer who is not one of the pass's big blinds is HELD, even when
 *     that costs the pass a hand, and the big blinds are taken again after
 *     every hold until nothing changes (a newcomer pushed out of the big-blind
 *     set by the shrink is held too);
 *   - when a hold would leave the pass no hand at all, it is not taken (the
 *     pass never stalls) and each newcomer it then seats outside the big
 *     blind POSTS A LIVE ENTRY BIG BLIND (20261025050528): one big blind, live,
 *     with the option, so their first hand costs and plays exactly like the
 *     big blind. The small blind goes to someone who is not an entry poster
 *     whenever anyone can hold it. So every newcomer a pass seats is the big
 *     blind or posts one;
 *   - the entry big blind is emitted only when the engine posts it and the
 *     participant row can record it (the gate inlined into the plan and the
 *     barrier: the x-smarter-lightning-entry-bb request header AND the widened
 *     blind_role constraint of 20261025050534), so no deployment order can
 *     deal an entry poster a free hand or freeze a Cluster on the constraint;
 *   - the rule is not a tunable: the config reports big_blind whatever a
 *     ruleset says, and lists anything else under `invalid`.
 *
 * Horses are players (CLAUDE.md 10.5): nothing here reads a horse marker.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LIGHTNING_MATCHER_PARAM_DEFAULTS,
  isLightningNewcomer,
  lightningMatcherModel,
  lightningMatcherParams,
  type LightningMatchPlan,
  type LightningPoolPlayer,
} from './LightningMatcherModel.js';
import { seededRandom } from './LightningMatcherSim.js';
import { LIGHTNING_ENTRY_BIG_BLIND_HEADER } from './LightningRpc.js';
import { LIGHTNING_ENTRY_BIG_BLIND_ROLE } from './LightningHandHost.js';

const ROOT = join(__dirname, '..', '..', '..');
const MIGRATION = join(
  ROOT,
  'supabase',
  'migrations',
  '20261024195059_lightning_new_players_are_always_the_big_blind_first.sql'
);
const SQL = readFileSync(MIGRATION, 'utf8');
const MODEL = readFileSync(join(__dirname, 'LightningMatcherModel.ts'), 'utf8');
const PLAN_BLOCK = SQL.slice(SQL.indexOf('$plan$'), SQL.lastIndexOf('$plan$'));
const ENTRY_SQL = readFileSync(
  join(
    ROOT,
    'supabase',
    'migrations',
    '20261025050528_lightning_newcomer_posts_a_live_entry_big_blind.sql'
  ),
  'utf8'
);
const WINDOW_SQL = readFileSync(
  join(
    ROOT,
    'supabase',
    'migrations',
    '20261025050534_lightning_hand_player_admits_the_entry_big_blind_role.sql'
  ),
  'utf8'
);
const HOST = readFileSync(join(__dirname, 'LightningHandHost.ts'), 'utf8');
const SUPERVISOR = readFileSync(join(__dirname, 'LightningSupervisor.ts'), 'utf8');
const CFG_BLOCK = SQL.slice(SQL.indexOf('$cfg$'), SQL.lastIndexOf('$cfg$'));

const NOW = 1_000_000;

/** A legal, long-idle pool player; `bbAt` null = never the big blind (a newcomer). */
function player(id: string, bbAt: number | null, extra: Partial<LightningPoolPlayer> = {}) {
  return {
    playerId: id,
    legal: true,
    reasonCode: null,
    idleSinceMs: 0,
    enteredAtMs: 0,
    joinedAtMs: 0,
    slotOpenedAtMs: 0,
    lastBbAtMs: bbAt,
    bbUnresolved: false,
    debtSinceMs: 0,
    handsSinceBb: bbAt === null ? null : 3,
    newcomer: bbAt === null,
    positions: { btn: 0, co: 0, hj: 0, utg: 0 },
    ...extra,
  } satisfies LightningPoolPlayer;
}
const newcomers = (n: number, prefix = 'n') =>
  Array.from({ length: n }, (_, i) => player(`${prefix}${String(i).padStart(2, '0')}`, null));
const regulars = (n: number, prefix = 'r') =>
  Array.from({ length: n }, (_, i) => player(`${prefix}${String(i).padStart(2, '0')}`, 100 + i));

const VERSIONS = ['m1', 'm1-port', 'm2'];
function plan(
  players: LightningPoolPlayer[],
  version = 'm1',
  entryBigBlind?: boolean
): LightningMatchPlan {
  return lightningMatcherModel(version)!.plan(
    {
      nowMs: NOW,
      players,
      recentHands: [],
      ...(entryBigBlind === undefined ? {} : { entryBigBlind }),
    },
    lightningMatcherParams({})
  );
}
const seated = (p: LightningMatchPlan) => new Set(p.groups.flatMap((g) => g.players));
/** Newcomers dealt into a seat other than the big blind. */
const newcomersOffTheBigBlind = (p: LightningMatchPlan, pool: LightningPoolPlayer[]) => {
  const nc = new Set(
    pool.filter((x) => x.lastBbAtMs === null && x.newcomer).map((x) => x.playerId)
  );
  return p.groups.flatMap((g) => g.players.slice(1)).filter((id) => nc.has(id));
};
/** Newcomers dealt neither the big blind nor an entry big blind: must be none. */
const newcomersWhoPostNoBigBlind = (p: LightningMatchPlan, pool: LightningPoolPlayer[]) => {
  const nc = new Set(
    pool.filter((x) => x.lastBbAtMs === null && x.newcomer).map((x) => x.playerId)
  );
  return p.groups.flatMap((g) =>
    g.players.filter((id) => nc.has(id) && id !== g.bb && !g.entryBb.includes(id))
  );
};
const isNewcomerIn = (pool: LightningPoolPlayer[]) => {
  const nc = new Set(
    pool.filter((x) => x.lastBbAtMs === null && x.newcomer).map((x) => x.playerId)
  );
  return (id: string) => nc.has(id);
};
/** Every structural promise of an entry plan, for every group. */
function expectEntryPlanSound(p: LightningMatchPlan, pool: LightningPoolPlayer[], label: string) {
  const isNew = isNewcomerIn(pool);
  expect(newcomersWhoPostNoBigBlind(p, pool), label).toEqual([]);
  for (const g of p.groups) {
    expect([5, 6], label).toContain(g.players.length);
    expect(g.entryBb, label).not.toContain(g.bb);
    // Only newcomers post an entry big blind, in seat order.
    expect(g.entryBb.every(isNew), label).toBe(true);
    expect(g.entryBb, label).toEqual(g.players.filter((id) => g.entryBb.includes(id)));
    // The small blind is an entry poster only when nobody else in the group could hold it.
    if (g.entryBb.includes(g.sb))
      expect(
        g.players.filter((id) => id !== g.bb && !g.entryBb.includes(id)),
        label
      ).toEqual([]);
  }
  expect(seated(p).size, label).toBe(p.groups.reduce((s, g) => s + g.players.length, 0));
}

describe("a new player's first Lightning hand is the big blind", () => {
  it.each(VERSIONS)(
    'holds the second of two newcomers rather than deal them a small blind (%s)',
    (v) => {
      const pool = [...newcomers(2), ...regulars(4)];
      const p = plan(pool, v);
      expect(p.groups).toHaveLength(1);
      expect(p.groups[0].bb).toBe('n00');
      expect(p.groups[0].players).toHaveLength(5);
      expect(seated(p).has('n01')).toBe(false);
      expect(newcomersOffTheBigBlind(p, pool)).toEqual([]);
    }
  );

  it.each(VERSIONS)(
    'holds a newcomer even when it costs the pass a hand, and re-takes the big blinds after each hold (%s)',
    (v) => {
      // Twelve legal, four newcomers: two hands, whose big blinds are n00 and
      // n01. Holding n02 and n03 leaves ten, one hand, so n01 is pushed out of
      // the big-blind set and is held too. The old rule (hold only while it
      // costs no hand) dealt two of these newcomers outside the big blind.
      const pool = [...newcomers(4), ...regulars(8)];
      const p = plan(pool, v);
      expect(p.groups).toHaveLength(1);
      expect(p.groups[0].bb).toBe('n00');
      for (const id of ['n01', 'n02', 'n03']) expect(seated(p).has(id)).toBe(false);
      expect(newcomersOffTheBigBlind(p, pool)).toEqual([]);
    }
  );

  it.each(VERSIONS)('never deadlocks a pool of only newcomers: the pass still deals (%s)', (v) => {
    for (const n of [5, 6, 7, 11, 12, 24]) {
      const p = plan(newcomers(n), v);
      expect(p.groups.length, `${n} newcomers`).toBeGreaterThan(0);
    }
  });

  it.each(VERSIONS)(
    'with five or more players who have been the big blind, no newcomer is ever dealt off the big blind (%s)',
    (v) => {
      const rand = seededRandom(20261024);
      for (let trial = 0; trial < 400; trial++) {
        const pool = [
          ...newcomers(Math.floor(rand() * 14)),
          ...regulars(5 + Math.floor(rand() * 30)),
        ].map((x) => ({
          ...x,
          idleSinceMs: Math.floor(rand() * 10_000),
          slotOpenedAtMs: Math.floor(rand() * 10_000),
          debtSinceMs: Math.floor(rand() * 10_000),
          bbUnresolved: x.lastBbAtMs !== null && rand() < 0.1,
        }));
        const p = plan(pool, v);
        expect(newcomersOffTheBigBlind(p, pool), `trial ${trial}`).toEqual([]);
        // Every hand still has five or six players and nobody is seated twice.
        for (const g of p.groups) expect([5, 6]).toContain(g.players.length);
        expect(seated(p).size).toBe(p.groups.reduce((s, g) => s + g.players.length, 0));
        // A pass with enough players who have been the big blind deals.
        expect(p.groups.length).toBeGreaterThan(0);
      }
    }
  );

  it('reads the slot that has never been the big blind; the stored flag can only exempt a conversion seat', () => {
    // 20261024213844: the database's `newcomer` is false for a seat the
    // epoch's conversion made (n01). It can never make a newcomer of a slot
    // that has been the big blind (r00 carries a stray true and is not one).
    const pool = [
      player('n00', null),
      player('n01', null, { newcomer: false }),
      ...regulars(4).map((r, i) => (i === 0 ? { ...r, newcomer: true } : r)),
    ];
    const p = plan(pool);
    expect(p.groups[0].bb).toBe('n00');
    expect(seated(p).has('n01')).toBe(true);
    expect(seated(p).has('r00')).toBe(true);
    expect(isLightningNewcomer(player('x', null, { newcomer: false }))).toBe(false);
    expect(isLightningNewcomer(player('x', null, { newcomer: true }))).toBe(true);
    expect(isLightningNewcomer(player('x', 5, { newcomer: true }))).toBe(false);
  });

  it('a player with an unresolved big blind still outranks a newcomer, who waits for the next pass', () => {
    const pool = [...newcomers(1), { ...player('d00', 50), bbUnresolved: true }, ...regulars(4)];
    const p = plan(pool);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0].bb).toBe('d00');
    expect(seated(p).has('n00')).toBe(false);
  });

  it('is always on: the live config can only say big_blind', () => {
    expect(LIGHTNING_MATCHER_PARAM_DEFAULTS.firstEntryRule).toBe('big_blind');
    for (const row of [{}, { first_entry_rule: 'any_seat' }, { first_entry_rule: 7 }, null])
      expect(lightningMatcherParams(row).firstEntryRule).toBe('big_blind');
  });
});

describe('when holding would leave no hand, a newcomer posts a live entry big blind (20261025050528)', () => {
  it.each(VERSIONS)(
    'conversion seats without a previous big blind never pay entry posts (%s)',
    (v) => {
      const converted = newcomers(3, 'c').map((p) => ({ ...p, newcomer: false }));
      const pool = [...converted, ...newcomers(2)];
      const p = plan(pool, v);
      expect(p.groups).toHaveLength(1);
      expect(p.groups[0].players).toHaveLength(5);
      expect(p.groups[0].bb).toBe('n00');
      expect(p.groups[0].entryBb).toEqual(['n01']);
      expect(p.groups[0].sb).toBe('c00');
      expectEntryPlanSound(p, pool, v);
    }
  );

  it.each(VERSIONS)(
    'two newcomers and three regulars: the second posts an entry big blind, a regular is the small blind (%s)',
    (v) => {
      const pool = [...newcomers(2), ...regulars(3)];
      const p = plan(pool, v);
      expect(p.groups).toHaveLength(1);
      const [g] = p.groups;
      expect(g.bb).toBe('n00');
      expect(g.entryBb).toEqual(['n01']);
      expect(g.sb).toBe('r00');
      expectEntryPlanSound(p, pool, v);
    }
  );

  it.each(VERSIONS)('three newcomers and three regulars: two entry big blinds (%s)', (v) => {
    const pool = [...newcomers(3), ...regulars(3)];
    const p = plan(pool, v);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0].bb).toBe('n00');
    expect([...p.groups[0].entryBb].sort()).toEqual(['n01', 'n02']);
    expect(p.groups[0].sb).toBe('r00');
    expectEntryPlanSound(p, pool, v);
  });

  it.each(VERSIONS)(
    'four newcomers and three regulars: the seated newcomers post, the small blind stays a regular (%s)',
    (v) => {
      const pool = [...newcomers(4), ...regulars(3)];
      const p = plan(pool, v);
      expect(p.groups).toHaveLength(1);
      const [g] = p.groups;
      expect(g.bb).toBe('n00');
      // Six of the seven are dealt; every newcomer seated outside the big blind posts.
      expect(g.players).toHaveLength(6);
      expect(g.entryBb.length).toBe(
        g.players.filter((id) => id.startsWith('n') && id !== 'n00').length
      );
      expect(g.entryBb.length).toBeGreaterThanOrEqual(2);
      expect(g.sb.startsWith('r')).toBe(true);
      expectEntryPlanSound(p, pool, v);
    }
  );

  it.each(VERSIONS)(
    'a pool of only newcomers: one big blind, five entry big blinds, the small blind seat among them (%s)',
    (v) => {
      const pool = newcomers(6);
      const p = plan(pool, v);
      expect(p.groups).toHaveLength(1);
      const [g] = p.groups;
      expect(g.bb).toBe('n00');
      expect(g.entryBb).toHaveLength(5);
      expect(g.entryBb).toContain(g.sb);
      expectEntryPlanSound(p, pool, v);
    }
  );

  it.each(VERSIONS)(
    'the second pass after four newcomers and eight regulars: the next newcomer is the big blind, the rest post (%s)',
    (v) => {
      const pool = [...newcomers(4), ...regulars(8)];
      const first = plan(pool, v);
      expect(first.groups).toHaveLength(1);
      expect(first.groups[0].entryBb).toEqual([]);
      // The first hand's players are in it (reserved); its big blind was stamped.
      const dealt = seated(first);
      const second = pool.filter((x) => !dealt.has(x.playerId));
      expect(second).toHaveLength(6);
      const p = plan(second, v);
      expect(p.groups).toHaveLength(1);
      expect(p.groups[0].bb).toBe('n01');
      expect([...p.groups[0].entryBb].sort()).toEqual(['n02', 'n03']);
      expectEntryPlanSound(p, second, v);
    }
  );

  it.each(VERSIONS)(
    '400 random pools of any mix: every newcomer is the big blind or posts one, and no pass that could deal stalls (%s)',
    (v) => {
      const rand = seededRandom(20261025);
      let entries = 0;
      for (let trial = 0; trial < 400; trial++) {
        const pool = [
          ...newcomers(Math.floor(rand() * 15)),
          ...regulars(Math.floor(rand() * 21)),
        ].map((x) => ({
          ...x,
          idleSinceMs: Math.floor(rand() * 10_000),
          slotOpenedAtMs: Math.floor(rand() * 10_000),
          debtSinceMs: Math.floor(rand() * 10_000),
          bbUnresolved: x.lastBbAtMs !== null && rand() < 0.1,
        }));
        const p = plan(pool, v);
        expectEntryPlanSound(p, pool, `trial ${trial}`);
        if (pool.length >= 5)
          expect(p.groups.length, `trial ${trial}: ${pool.length} legal`).toBeGreaterThan(0);
        entries += p.groups.reduce((s, g) => s + g.entryBb.length, 0);
      }
      // The sweep exercises the entry big blind, not only the hold.
      expect(entries).toBeGreaterThan(50);
    }
  );

  it('an entry poster is stamped like the big blind: on the next pass they are not a newcomer', () => {
    const pool = [...newcomers(2), ...regulars(3)];
    const p = plan(pool);
    const posted = new Set([p.groups[0].bb, ...p.groups[0].entryBb]);
    const next = pool.map((x) =>
      posted.has(x.playerId) ? { ...x, lastBbAtMs: NOW, handsSinceBb: 0 } : x
    );
    expect(next.filter(isLightningNewcomer)).toEqual([]);
    expect(plan(next).groups[0].entryBb).toEqual([]);
  });

  it('with the gate closed (the database cannot record it yet), the plan is the plan before this change', () => {
    const pool = [...newcomers(2), ...regulars(3)];
    const off = plan(pool, 'm1', false);
    expect(off.groups[0].entryBb).toEqual([]);
    expect(off.groups[0].sb).toBe('n01');
    expect(newcomersOffTheBigBlind(off, pool)).toEqual(['n01']);
    // Where no newcomer is seated off the big blind, open and closed agree exactly.
    const rand = seededRandom(7);
    for (let trial = 0; trial < 200; trial++) {
      const pool2 = [
        ...newcomers(Math.floor(rand() * 4)),
        ...regulars(5 + Math.floor(rand() * 20)),
      ];
      const on = plan(pool2, 'm1', true);
      if (on.groups.some((g) => g.entryBb.length > 0)) continue;
      expect(JSON.stringify(plan(pool2, 'm1', false))).toBe(JSON.stringify(on));
    }
  });
});

describe('the entry big blind in SQL, and its activation order (20261025050528, 20261025050534)', () => {
  it('replaces the three live definitions only from their qualified sources, every anchor exactly once, in one short transaction', () => {
    for (const sig of [
      'public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)',
      'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamptz,text,uuid,jsonb)',
      'public.fn_lightning_instance_releases_its_reservations()',
    ])
      expect(ENTRY_SQL).toMatch(
        new RegExp(`\\('${sig.replace(/[()[\]]/g, '\\$&')}', '[0-9a-f]{32}'\\)`)
      );
    expect(ENTRY_SQL).toContain('is not exactly once');
    expect(ENTRY_SQL).toMatch(/^-- @live-proof: .*ENTRY BIG BLIND/m);
    expect(ENTRY_SQL).toContain("SET LOCAL lock_timeout = '1s';");
    expect(ENTRY_SQL).toContain("SET LOCAL statement_timeout = '8s';");
    expect(ENTRY_SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(ENTRY_SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(ENTRY_SQL).not.toMatch(
      /ALTER\s+TABLE|CREATE\s+(TABLE|INDEX|TYPE|VIEW|TRIGGER|SEQUENCE)|LOCK\s+TABLE/i
    );
  });

  it('the gate is both halves, the engine header AND the widened constraint, one text in both functions', () => {
    const gate = ENTRY_SQL.slice(ENTRY_SQL.indexOf('$g$'), ENTRY_SQL.lastIndexOf('$g$'));
    expect(gate).toContain(`'${LIGHTNING_ENTRY_BIG_BLIND_HEADER}'`);
    expect(gate).toContain("current_setting('request.headers', true)");
    expect(gate).toContain("c.conname = 'lightning_hand_player_blind_role_check'");
    expect(gate).toContain(
      "position('''entry_bb''' IN pg_catalog.pg_get_constraintdef(c.oid)) > 0"
    );
    expect(gate).toContain('EXCEPTION WHEN invalid_text_representation THEN');
    expect(gate).toContain('v_entry_on := false;');
    // Substituted into the plan and the barrier (two anchors), and the install
    // refuses a definition that still carries the placeholder.
    expect(ENTRY_SQL.match(/^@@ENTRY_GATE@@ {2}IF v_entry_on THEN$/gm)).toHaveLength(2);
    expect(ENTRY_SQL).toContain("replace(e.new_text, '@@ENTRY_GATE@@', v_gate)");
    expect(ENTRY_SQL).toContain("position('@@ENTRY_GATE@@' IN n) > 0");
    // No new object: nothing this migration declares is absent from the live schema.
    expect(ENTRY_SQL).not.toMatch(/^\s*CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/im);
    // The engine sends exactly that header on its Lightning RPCs.
    expect(SUPERVISOR).toMatch(/\.setHeader\(LIGHTNING_ENTRY_BIG_BLIND_HEADER, '1'\)/);
    expect(LIGHTNING_ENTRY_BIG_BLIND_HEADER).toBe('x-smarter-lightning-entry-bb');
  });

  it('the plan seats the entry posters after the hold loop, takes the small blind from the others first, and says so', () => {
    expect(ENTRY_SQL).toContain('WHERE u.pid = ANY (v_newcomer) ORDER BY u.ord);');
    expect(ENTRY_SQL).toContain(
      "ORDER BY (u.pid = ANY (v_entry)), (v_info -> u.pid::text ->> 'p2')::integer LIMIT v_g);"
    );
    expect(ENTRY_SQL).toContain("'entry_bb', to_jsonb(ARRAY(");
    expect(ENTRY_SQL).toContain("'entry_big_blind', v_entry_on,");
    // The hold loop itself, with its no-stall exit, is untouched.
    expect(ENTRY_SQL).not.toContain('EXIT WHEN v_g2 = 0;');
    // The TypeScript port mirrors it line for line.
    expect(MODEL).toContain('const entryOn = snapshot.entryBigBlind ?? params.entryBigBlind;');
    expect(MODEL).toContain('rest.filter(isLightningNewcomer)');
    expect(MODEL).toMatch(/isEntry\(a\) - isEntry\(b\) \|\| compareBlindOrder\(a, b\)/);
  });

  it('the barrier records entry_bb, stamps it like the big blind, counts it in bb_count, and never stamps a small blind it did not post', () => {
    expect(ENTRY_SQL).toContain(
      `'blind_role', CASE WHEN s.pid = ANY (v_entry) THEN '${LIGHTNING_ENTRY_BIG_BLIND_ROLE}'`
    );
    expect(ENTRY_SQL).toContain("AND coalesce((t.e ->> 'newcomer')::boolean, false)");
    expect(ENTRY_SQL).toContain("'newcomer',        @@NEWCOMER@@,");
    expect(ENTRY_SQL).toContain('LIGHTNING_CONVERSION_SEAT');
    expect(ENTRY_SQL).toContain("'@@NEWCOMER@@', v_newcomer");
    expect(ENTRY_SQL).toContain(
      'last_bb_at     = CASE WHEN sl.player_id = v_bb OR sl.player_id = ANY (v_entry) THEN p_now'
    );
    expect(ENTRY_SQL).toContain(
      'hands_since_bb = CASE WHEN sl.player_id = v_bb OR sl.player_id = ANY (v_entry) THEN 0'
    );
    expect(ENTRY_SQL).toContain(
      'last_sb_at     = CASE WHEN sl.player_id = v_sb AND NOT (sl.player_id = ANY (v_entry)) THEN p_now'
    );
    expect(ENTRY_SQL).toContain(
      "(coalesce(hp.blind_role, 'none') IN ('bb', 'entry_bb'))::integer,"
    );
    // Exactly one big blind still; seat 1 is the small blind or a dead small blind's entry poster.
    expect(ENTRY_SQL).toContain(
      "AND (hp.blind_role = 'sb' OR (hp.seat = 1 AND hp.blind_role = 'entry_bb'))) <> 1"
    );
  });

  it('a hand voided before dealing gives an entry poster back their stamps and ledger credit', () => {
    expect(ENTRY_SQL).toContain(
      "(coalesce(hp.blind_role, 'none') IN ('bb', 'entry_bb'))::integer AS bb,"
    );
    expect(ENTRY_SQL).toContain("coalesce(hp.blind_role, 'none') IN ('bb', 'entry_bb') AS was_bb,");
    expect(ENTRY_SQL).toContain("FILTER (WHERE d.blind_role IN ('bb', 'entry_bb'))  AS bb_at,");
  });

  it('the constraint is widened in the daily window, by one value, NOT VALID, guarded against drift', () => {
    expect(WINDOW_SQL).toMatch(/^-- @install-window: daily-maintenance$/m);
    expect(WINDOW_SQL).toContain("SET LOCAL lock_timeout = '1s';");
    expect(WINDOW_SQL).toContain("SET LOCAL statement_timeout = '5s';");
    expect(WINDOW_SQL).toContain(
      "CHECK (blind_role IS NULL OR blind_role = ANY (ARRAY['none', 'sb', 'bb', 'both', 'dead_sb', 'straddle', 'entry_bb']))"
    );
    expect(WINDOW_SQL).toMatch(/\)\)\s+NOT VALID;/);
    expect(WINDOW_SQL).toContain('requalify the entry big blind role');
    expect(WINDOW_SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(WINDOW_SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('the host posts what the barrier recorded, and refuses any role it does not deal', () => {
    expect(LIGHTNING_ENTRY_BIG_BLIND_ROLE).toBe('entry_bb');
    expect(HOST).toContain('.filter((p) => p.blindRole === LIGHTNING_ENTRY_BIG_BLIND_ROLE)');
    expect(HOST).toMatch(/bbOnlyPosts:\s*\n?\s*entryBigBlindSeats\.length > 0/);
    expect(HOST).toContain("sb.blindRole === 'sb' ? sb.seat : null");
    expect(HOST).toContain("p.blindRole !== 'none' &&");
  });

  it('never reads a horse marker (CLAUDE.md 10.5)', () => {
    expect(ENTRY_SQL).not.toMatch(/is_horse|horse_id/);
    expect(WINDOW_SQL).not.toMatch(/is_horse|horse_id/);
  });
});

describe('the live SQL plan says the same thing (migration 20261024195059)', () => {
  it('replaces the three live definitions only from their qualified sources, in one short transaction', () => {
    for (const sig of [
      'public.fn_lightning_config(uuid)',
      'public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)',
      'public.fn_lightning_matcher_snapshot(uuid,timestamptz,uuid[],jsonb)',
    ])
      expect(SQL).toMatch(new RegExp(`\\('${sig.replace(/[()[\]]/g, '\\$&')}', '[0-9a-f]{32}'\\)`));
    expect(SQL).toMatch(/^-- @live-proof: .*NEW PLAYERS ARE ALWAYS THE BIG BLIND FIRST/m);
    expect(SQL).toContain("SET LOCAL lock_timeout = '1s';");
    expect(SQL).toContain("SET LOCAL statement_timeout = '8s';");
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).not.toMatch(/CREATE\s+(TABLE|INDEX|TYPE|VIEW|TRIGGER|SEQUENCE)/i);
  });

  it('a newcomer is a slot that has never been the big blind, in the plan and the snapshot', () => {
    expect(SQL).toContain("'           (bo.last_bb_at IS NULL) AS newcomer,'");
    expect(SQL).toContain("'''newcomer'',sl.last_bb_at IS NULL,'");
    expect(MODEL).toContain('p.lastBbAtMs === null');
  });

  it('holds newcomers until the big blinds settle, even at the cost of a hand, unless no hand is left', () => {
    expect(PLAN_BLOCK).toContain('LOOP');
    expect(PLAN_BLOCK).toContain('EXIT WHEN v_g = 0;');
    expect(PLAN_BLOCK).toContain('EXIT WHEN cardinality(v_next) = cardinality(v_seatable);');
    expect(PLAN_BLOCK).toContain('EXIT WHEN v_g2 = 0;');
    expect(PLAN_BLOCK).toContain('v_g := v_g2;');
    // The old "only while it costs no hand" condition and the switch are gone.
    expect(PLAN_BLOCK).not.toContain('IF v_g2 = v_g THEN');
    expect(PLAN_BLOCK).not.toContain("v_rule = 'big_blind'");
    expect(SQL).toContain("position('IF v_g2 = v_g THEN' IN n) > 0");
    // The TypeScript port runs the same loop.
    expect(MODEL).toMatch(
      /if \(g === 0\) break;[\s\S]*if \(next\.length === seatable\.length\) break;[\s\S]*if \(g2 === 0\) break;[\s\S]*g = g2;/
    );
    expect(MODEL).not.toMatch(/=== g\) \{\s*seatable = next;/);
  });

  it('the config reports big_blind always and lists any other value as invalid', () => {
    expect(CFG_BLOCK).toContain("v_rule := 'big_blind';");
    expect(CFG_BLOCK).toContain("'first_entry_is_always_big_blind'");
    expect(CFG_BLOCK).not.toContain("v_rule := 'any_seat'");
  });

  it('never reads a horse marker (CLAUDE.md 10.5)', () => {
    for (const src of [SQL, PLAN_BLOCK, CFG_BLOCK]) expect(src).not.toMatch(/is_horse|horse_id/);
    expect(MODEL).not.toMatch(/is_horse|horse_id|isHorse/);
  });
});
