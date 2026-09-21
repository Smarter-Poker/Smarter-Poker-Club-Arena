/**
 * LIGHTNING 2.0 PHASE 2: DOMAIN / DATABASE EXTENSIONS
 *
 * "Add only missing entities/fields. Do not duplicate existing concepts."
 *
 * The behavioural proof runs against a real PostgreSQL 17 in
 * scripts/dev/test-lightning-phase2-domain.sh. This file pins what is only
 * visible in the source, and above all the THREE decisions that a later phase
 * could quietly undo, each of which was found by adversarial verification of
 * an earlier draft rather than by review:
 *
 *   1. state, orbit position and wait percentiles are PER TABLE, because a
 *      multi-tabling player has three of each and one column cannot say so;
 *   2. the money and the blind debt are PER IDENTITY, because they are owed by
 *      the human and not by the chair;
 *   3. nothing derived is stored.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_.sql';
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', FILE), 'utf8');
/** Comment-stripped, so no pin can be satisfied by prose. */
const CODE = SQL.replace(/--[^\n]*/g, '');
const FRAGMENT = path.join(
  ROOT,
  'scripts',
  'ci',
  'schema-manifest.d',
  'lightning-phase2-domain.json'
);
const HARNESS = path.join(ROOT, 'scripts', 'dev', 'test-lightning-phase2-domain.sh');

const RELATIONS = [
  'lightning_pool_session',
  'lightning_pool_slot',
  'lightning_instance',
  'lightning_reservation',
  'lightning_blind_ledger',
  'lightning_hand',
  'lightning_hand_player',
];

/** The body of one CREATE TABLE, so a column pin cannot match another table. */
function table(name: string): string {
  const start = CODE.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
  expect(start, `${name} is not created`).toBeGreaterThan(-1);
  return CODE.slice(start, CODE.indexOf('\n);', start));
}

/**
 * The column NAMES of one CREATE TABLE, parsed rather than searched for. A
 * substring cannot tell `hands` from `hands_since_bb`, nor a column from a word
 * inside a CHECK, and the manifest comparison below needs real names on both
 * sides to be a comparison at all. A column line is indented two spaces and is
 * not one of the table-level constraint keywords.
 */
function columnsOf(name: string): string[] {
  const out: string[] = [];
  for (const line of table(name).split('\n').slice(1)) {
    const m = /^ {2}(\w+)\s+\S/.exec(line);
    if (!m) continue;
    if (['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'EXCLUDE'].includes(m[1])) continue;
    out.push(m[1]);
  }
  return out;
}

describe('Phase 2: the seven relations exist and are locked down', () => {
  it('creates every relation the domain is missing, and no others', () => {
    const created = [...CODE.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+) \(/g)].map(
      (m) => m[1]
    );
    expect(created.sort()).toEqual([...RELATIONS].sort());
  });

  it('enables row level security on every one', () => {
    for (const r of RELATIONS) {
      expect(CODE).toContain(`ALTER TABLE public.${r} ENABLE ROW LEVEL SECURITY;`);
    }
  });

  it('revokes every browser-facing role from every one', () => {
    for (const r of RELATIONS) {
      expect(CODE).toContain(`REVOKE ALL ON TABLE public.${r} FROM PUBLIC, anon, authenticated;`);
    }
  });

  it('STATES the service_role grant rather than inheriting it', () => {
    // BYPASSRLS bypasses ROW security and is not a table privilege. Without an
    // explicit GRANT these relations are reachable only through the project's
    // ALTER DEFAULT PRIVILEGES, and would become unreachable the day those are
    // tightened. Every sibling table in this estate states it.
    for (const r of RELATIONS) {
      expect(CODE).toContain(`GRANT ALL ON TABLE public.${r} TO service_role;`);
    }
  });

  it('creates no policy, matching the estate posture for non-user data', () => {
    expect(CODE).not.toMatch(/CREATE POLICY/i);
  });
});

describe('Phase 2: what is per TABLE is on the slot, not the participation', () => {
  it('puts the orbit position on lightning_pool_slot', () => {
    const slot = table('lightning_pool_slot');
    for (const c of [
      'hands_since_bb',
      'hands_since_sb',
      'last_bb_at',
      'last_sb_at',
      'last_button_at',
    ]) {
      expect(slot).toContain(c);
    }
  });

  it('keeps the orbit position OFF the blind ledger', () => {
    // A player at three tables has three independent orbits. One integer
    // standing in for three makes an "oldest unresolved BB" index answer the
    // wrong question: posting a blind at one table would instantly
    // deprioritise the player at the others, where they may genuinely owe one.
    const ledger = table('lightning_blind_ledger');
    for (const c of [
      'hands_since_bb',
      'hands_since_sb',
      'last_bb_at',
      'last_sb_at',
      'last_button_at',
    ]) {
      expect(ledger).not.toContain(c);
    }
  });

  it('puts the wait distribution on the slot, never on the participation', () => {
    // A percentile cannot be merged across slots by any arithmetic, so a
    // session-level p95 is last-writer-wins. And a multi-tabler waits at three
    // tables while playing a fourth, so a summed wait would exceed the elapsed
    // session and inflate the derived mean by the table count.
    const slot = table('lightning_pool_slot');
    const session = table('lightning_pool_session');
    for (const c of ['p95_wait_ms', 'p99_wait_ms', 'wait_total_ms', 'wait_samples']) {
      expect(slot).toContain(c);
      expect(session).not.toContain(c);
    }
  });

  it('puts the per-table counters on the slot, never on the participation', () => {
    const slot = table('lightning_pool_slot');
    const session = table('lightning_pool_session');
    for (const c of ['hands', 'fast_folds', 'normal_folds', 'fold_and_watch', 'showdowns']) {
      expect(slot).toContain(c);
      expect(session).not.toContain(c);
    }
  });

  it('narrows the participation state to the seven that aggregate', () => {
    const session = table('lightning_pool_session');
    for (const s of [
      'joining',
      'eligibility_check',
      'active',
      'sit_out',
      'disconnected',
      'leaving',
      'closed',
    ]) {
      expect(session).toContain(`'${s}'`);
    }
    // The per-hand states are derived from a live reservation and the instance
    // it names. A multi-tabler holds several at once.
    for (const s of [
      'idle_pool',
      'matching',
      'reserved',
      'in_instance',
      'in_hand',
      'folded',
      'watching',
      'ghost_bb',
    ]) {
      expect(session).not.toContain(`'${s}'`);
    }
  });

  it('lets one table close while its siblings keep playing', () => {
    expect(CODE).toMatch(/lightning_pool_slot_one_open[\s\S]{0,160}?WHERE closed_at IS NULL/);
    expect(table('lightning_pool_slot')).toContain('close_reason');
  });
});

describe('Phase 2: what is per IDENTITY stays per identity', () => {
  it('keeps the blind debt and the fairness totals on the ledger', () => {
    const ledger = table('lightning_blind_ledger');
    for (const c of [
      'bb_count',
      'sb_count',
      'btn_count',
      'missed_bb_debt',
      'missed_sb_debt',
      'bb_owed',
      'sb_owed',
    ]) {
      expect(ledger).toContain(c);
    }
    expect(CODE).toContain(
      'CONSTRAINT lightning_blind_ledger_pkey PRIMARY KEY (cluster_id, player_id)'
    );
  });

  it('keeps the money on the participation, not on the table', () => {
    const session = table('lightning_pool_session');
    for (const c of ['starting_stack', 'ending_stack', 'net_result']) {
      expect(session).toContain(c);
    }
  });
});

describe('Phase 2: the invariants are constraints, not intentions', () => {
  it('refuses a second open participation per player per cluster', () => {
    expect(CODE).toMatch(
      /lightning_pool_session_one_open[\s\S]{0,140}?\(player_id, cluster_id\)[\s\S]{0,60}?WHERE exited_at IS NULL/
    );
  });

  it('refuses a one-player Lightning instance', () => {
    expect(CODE).toMatch(/target_size >= 2/);
    expect(CODE).toMatch(/max_size >= target_size AND max_size <= 9/);
  });

  it('refuses two pending holds on one table, and permits one per table', () => {
    expect(CODE).toMatch(
      /lightning_reservation_one_pending_per_slot[\s\S]{0,140}?\(pool_slot_id\)[\s\S]{0,60}?WHERE state = 'pending'/
    );
  });

  it('refuses one player holding two seats at one instance', () => {
    // The reservation layer would otherwise accept a pair the hand layer can
    // never commit: lightning_hand_player is keyed (hand_id, player_id), so
    // the matcher would fail at the primary key after both holds were out.
    expect(CODE).toMatch(
      /lightning_reservation_one_seat_per_player_instance[\s\S]{0,200}?\(player_id, lightning_instance_id\)/
    );
    expect(CODE).toMatch(
      /WHERE state IN \('pending', 'committed'\) AND lightning_instance_id IS NOT NULL/
    );
  });

  it('gives every hold an expiry that is after its creation', () => {
    expect(CODE).toContain(
      'CONSTRAINT lightning_reservation_expires_after_creation CHECK (expires_at > created_at)'
    );
  });

  it('holds a chair for one player, and holds a player once in one hand', () => {
    // And that is all it holds, which is why this case is no longer named after
    // the formation barrier. The barrier itself - a committed hand has at least
    // two players, and no seat exceeds its instance's max_size - is a statement
    // about a SET of rows, which no CHECK constraint can ever see, so it belongs
    // to the formation function of spec Phase 9: the only writer that will hold
    // the whole set at once.
    expect(CODE).toContain(
      'CONSTRAINT lightning_hand_player_pkey PRIMARY KEY (hand_id, player_id)'
    );
    expect(CODE).toMatch(/lightning_hand_player_one_per_seat[\s\S]{0,120}?\(hand_id, seat\)/);
  });

  it('names every CHECK, so a later migration can address it', () => {
    const anonymous = [...CODE.matchAll(/,\s*\n\s*CHECK \(/g)];
    expect(anonymous.length, 'an inline CHECK gets a system-generated name').toBe(0);
  });
});

describe('Phase 2: scope and safety', () => {
  it('adds the epoch to the event ledger with a default every cluster is at', () => {
    expect(CODE).toMatch(
      /ALTER TABLE public\.cash_cluster_events\s+ADD COLUMN IF NOT EXISTS cluster_epoch integer NOT NULL DEFAULT 0;/
    );
  });

  it('declares one ADD COLUMN per ALTER TABLE, as the applied-check requires', () => {
    const added = [...CODE.matchAll(/ADD\s+COLUMN\b/gi)];
    const alters = [...CODE.matchAll(/ALTER TABLE public\.\w+\s+ADD\s+COLUMN\b/gi)];
    expect(alters.length).toBe(added.length);
  });

  it('puts no foreign key on any pre-existing relation', () => {
    // The estate has lost minutes of Postgres to an FK taking SHARE ROW
    // EXCLUSIVE for the length of a transaction. Inside the Lightning family
    // the parents are new and cold, so two cascades are affordable.
    expect(CODE).not.toMatch(
      /REFERENCES\s+public\.(tables|cash_games|cash_player_session|table_seats|hand_history|hand_atomic_commits)/
    );
    const refs = [...CODE.matchAll(/REFERENCES\s+public\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(refs)].sort()).toEqual(['lightning_pool_session', 'lightning_pool_slot']);
  });

  it('does not widen any hot hand relation', () => {
    for (const hot of [
      'hand_history',
      'hand_atomic_commits',
      'ca_hand_facts',
      'table_seats',
      'tables',
    ]) {
      expect(CODE).not.toMatch(new RegExp(`ALTER TABLE public\\.${hot}\\b`));
    }
  });

  it('stores nothing that can be derived', () => {
    for (const derived of ['hands_per_hour', 'average_wait', 'bb_per_100', 'occupancy']) {
      expect(CODE).not.toContain(derived);
    }
  });

  it('ships no matcher, no threshold, no conversion and no formation logic', () => {
    // Phases 6, 4, 5 and 9. Phase 2 is entities only.
    expect(CODE).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
    expect(CODE).not.toMatch(/CREATE (OR REPLACE )?TRIGGER/i);
    const executable = CODE.replace(/COMMENT\s+ON[\s\S]*?;\s*$/gim, '');
    expect(executable).not.toMatch(/thresholds?/i);
  });

  it('creates every relation empty: no seeding, no backfill', () => {
    expect(CODE).not.toMatch(/INSERT INTO public\.lightning/i);
    expect(CODE).not.toMatch(/UPDATE public\.lightning/i);
  });

  it('is a single transaction', () => {
    expect((CODE.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((CODE.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
  });

  it('declares live proofs, none of which can be a tautology', () => {
    const proofs = [...SQL.matchAll(/--\s*@live-proof:\s*(.+?)\s*$/gim)].map((m) => m[1]);
    expect(proofs.length).toBeGreaterThanOrEqual(6);
    for (const p of proofs) expect(p).not.toContain(';');
    // Every relation is new, so counting them is a real test of arrival.
    expect(proofs.join('\n')).toContain('count(*) = 7 FROM information_schema.tables');
    expect(proofs.join('\n')).toContain('relrowsecurity');
  });

  it('declares exactly what it creates to the schema manifest, in both directions', () => {
    // BOTH DIRECTIONS, AND BY EXACT NAME. This case used to ask only that every
    // DECLARED column appeared somewhere in its table's text, which a substring
    // of a longer column's name satisfies and which says nothing whatever about
    // a column the migration creates and the fragment never mentions. An
    // over-declaration turns the nightly Schema Integrity Audit red and is
    // therefore self-announcing; an UNDER-declaration is the quiet one, because
    // the audit simply stops watching whatever was left out. So the two sides
    // are compared as SETS, of parsed names, in both directions.
    const frag = JSON.parse(fs.readFileSync(FRAGMENT, 'utf8'));
    expect([...frag.tables].sort()).toEqual([...RELATIONS].sort());
    expect(frag.columns.cash_cluster_events).toEqual(['cluster_epoch']);
    expect(frag.functions).toBeUndefined();

    // Every relation the migration creates is declared, and no other is.
    const created = [...CODE.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+) \(/g)].map(
      (m) => m[1]
    );
    expect([...frag.tables].sort()).toEqual([...created].sort());

    // Every function it creates is declared, and no other is. It creates none,
    // so the fragment must declare none - which is what `functions` being
    // absent means, and it is asserted above rather than assumed here.
    const functions = [...CODE.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)/gi)].map(
      (m) => m[1]
    );
    expect(functions).toEqual([]);
    expect([...(frag.functions ?? [])].sort()).toEqual([...functions].sort());

    // Every column of every created relation, by exact membership on two parsed
    // arrays rather than by substring against the table body.
    for (const t of created) {
      expect([...frag.columns[t]].sort(), t).toEqual([...columnsOf(t)].sort());
    }

    // The columns added to a PRE-EXISTING relation are declared the same way.
    const altered = new Map<string, string[]>();
    for (const m of CODE.matchAll(/ALTER TABLE public\.(\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)/g)) {
      altered.set(m[1], [...(altered.get(m[1]) ?? []), m[2]]);
    }
    for (const [t, cols] of altered) {
      expect([...frag.columns[t]].sort(), t).toEqual([...cols].sort());
    }

    // And the fragment names no relation this migration never touches.
    expect(Object.keys(frag.columns).sort()).toEqual([...created, ...altered.keys()].sort());
  });

  it('is qualified by a real PostgreSQL harness that CI runs', () => {
    expect(fs.existsSync(HARNESS)).toBe(true);
    const sh = fs.readFileSync(HARNESS, 'utf8');
    expect(sh).toContain('initdb');
    expect(sh).toContain(FILE);
    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain('bash scripts/dev/test-lightning-phase2-domain.sh');
  });
});
