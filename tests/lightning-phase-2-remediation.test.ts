/**
 * LIGHTNING 2.0 PHASE 2 REMEDIATION
 *
 * An adversarial audit of the merged 20260920235343 found two holes that a
 * schema phase exists to close and did not: the hand family carried the
 * columns of the identity principle and none of its keys, and cluster_epoch
 * was an integer with no authority behind it. 20260921025504 closes both while
 * all seven Lightning relations are still empty, which is the only window in
 * which the repair is a catalogue edit rather than a maintenance window.
 *
 * The behavioural proof runs against a real PostgreSQL 17 in
 * scripts/dev/test-lightning-phase2-remediation.sh. This file pins what is only
 * visible in the source, and above all the four decisions that a later phase
 * could quietly undo, each of which was found by mutating a copy of the
 * migration rather than by reading it:
 *
 *   1. an epoch is a ROW, because the only record that an old epoch ever
 *      existed must outlive the bump that ends it;
 *   2. the genesis backfill copies each cluster's OWN mode, because a constant
 *      there would file every existing cluster under a seating regime it never
 *      ran;
 *   3. every child foreign key comes off BEFORE the unique constraint it
 *      targets, because a migration that cannot be applied twice cannot be
 *      re-applied after a partial failure;
 *   4. the event ledger's trigger returns NEW untouched when the row already
 *      names an epoch, because an author who names one is obeyed.
 *
 * LIGHTNING_P2R_MIGRATION overrides the file under test. It exists so that
 * mutation testing - copying the migration to a scratch directory, deleting one
 * statement from the copy and watching this suite go red - never has to touch
 * the migration in the repository. It is the same mechanism the harness takes
 * as LIGHTNING_PHASE2R_MIGRATION.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20260921025504_lightning_phase_2_remediation_the_hand_knows_its_cluster_its.sql';
const MIGRATION =
  process.env.LIGHTNING_P2R_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
/** Comment-stripped, so no pin below can be satisfied by prose. */
const CODE = SQL.replace(/--[^\n]*/g, '');

/** The body of one CREATE TABLE, so a column pin cannot match another table. */
function table(name: string): string {
  const start = CODE.indexOf(`CREATE TABLE IF NOT EXISTS public.${name} (`);
  expect(start, `${name} is not created`).toBeGreaterThan(-1);
  return CODE.slice(start, CODE.indexOf('\n);', start));
}

/** One ALTER TABLE ... ADD CONSTRAINT statement, up to its semicolon. */
function added(name: string): string {
  const needle = `ADD CONSTRAINT ${name}`;
  const start = CODE.indexOf(needle);
  expect(start, `${name} is never added`).toBeGreaterThan(-1);
  return CODE.slice(start, CODE.indexOf(';', start));
}

/** The column list of a parenthesised clause, as written. */
function tuple(stmt: string, after: string): string[] {
  const start = stmt.indexOf(after);
  expect(start, `${after} is absent`).toBeGreaterThan(-1);
  const open = stmt.indexOf('(', start);
  return stmt
    .slice(open + 1, stmt.indexOf(')', open))
    .split(',')
    .map((c) => c.trim());
}

describe('Phase 2 remediation: the epoch becomes a row', () => {
  it('creates cash_cluster_epoch keyed by the cluster and the epoch', () => {
    expect(table('cash_cluster_epoch')).toBeTruthy();
    expect(CODE).toContain('CONSTRAINT cash_cluster_epoch_pkey PRIMARY KEY (cluster_id, epoch)');
    for (const c of ['cluster_id', 'epoch', 'mode', 'started_by', 'started_at', 'ended_at']) {
      expect(table('cash_cluster_epoch')).toContain(c);
    }
  });

  it('names every CHECK it writes, so a later migration can address one', () => {
    // A system-generated name cannot be dropped by a migration that did not
    // read the catalogue first, which makes the constraint unrepairable.
    expect(CODE).toContain('CONSTRAINT cash_cluster_epoch_nonneg CHECK (epoch >= 0)');
    expect(CODE).toContain('CONSTRAINT cash_cluster_epoch_mode_check CHECK (mode IN (');
    expect(CODE).toContain('CONSTRAINT cash_cluster_epoch_ends_after_it_starts CHECK (');
    const body = table('cash_cluster_epoch');
    expect([...body.matchAll(/,\s*\n\s*CHECK \(/g)].length).toBe(0);
  });

  it('ties every epoch row to a real cluster', () => {
    expect(CODE).toMatch(
      /CONSTRAINT cash_cluster_epoch_belongs_to_a_cluster\s+FOREIGN KEY \(cluster_id\) REFERENCES public\.cash_games \(id\) ON DELETE CASCADE/
    );
  });

  it('locks the new relation down the way every sibling table is locked down', () => {
    // BYPASSRLS bypasses ROW security and is not a table privilege, so the
    // service_role grant is STATED rather than inherited from the project's
    // ALTER DEFAULT PRIVILEGES, which may be tightened one day.
    expect(CODE).toContain('ALTER TABLE public.cash_cluster_epoch ENABLE ROW LEVEL SECURITY;');
    expect(CODE).toContain(
      'REVOKE ALL ON TABLE public.cash_cluster_epoch FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain('GRANT ALL ON TABLE public.cash_cluster_epoch TO service_role;');
  });

  it('says in the catalogue what the table is for', () => {
    expect(SQL).toMatch(/COMMENT ON TABLE public\.cash_cluster_epoch IS\s+'/);
  });

  it('lets one epoch be open per cluster, and only one', () => {
    // This is what makes "the current epoch" a question with one answer, and
    // it is what a conversion will contend on: end the old row and insert the
    // new one in the same transaction or neither happens. A non-partial index
    // would forbid a cluster from ever having a second epoch at all.
    expect(CODE).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS cash_cluster_epoch_current\s+ON public\.cash_cluster_epoch \(cluster_id\)\s+WHERE ended_at IS NULL;/
    );
  });
});

describe('Phase 2 remediation: the genesis backfill copies the cluster, not a constant', () => {
  const BACKFILL = CODE.slice(
    CODE.indexOf('INSERT INTO public.cash_cluster_epoch'),
    CODE.indexOf(';', CODE.indexOf('INSERT INTO public.cash_cluster_epoch')) + 1
  );

  it('takes each cluster its own epoch, its own mode and its own birthday', () => {
    expect(BACKFILL).toContain('g.cluster_epoch');
    expect(BACKFILL).toContain('g.cluster_mode');
    expect(BACKFILL).toContain('g.created_at');
    expect(BACKFILL).toContain('FROM public.cash_games g');
    expect(BACKFILL).toContain('ON CONFLICT (cluster_id, epoch) DO NOTHING');
  });

  it('writes no literal mode, because a constant there was the mutation to catch', () => {
    // Substituting 'must_move' for g.cluster_mode survives every count-based
    // check there is: the same number of rows arrive, all of them open, all of
    // them keyed correctly. What it destroys is the one thing the table exists
    // to record - the regime each cluster actually ran under - and it destroys
    // it silently, for every cluster that was in any other mode.
    expect(BACKFILL).not.toContain("'must_move'");
  });

  it('refuses to continue if any cluster is left without an open epoch row', () => {
    // The foreign keys further down reference (cluster_id, epoch). A cluster
    // the backfill missed would have every future Lightning write refused, and
    // the refusal would arrive months later at a seat request rather than here.
    const guard = CODE.slice(CODE.indexOf('DO $$'), CODE.indexOf('END $$;') + 7);
    expect(guard).toContain('FROM public.cash_games g');
    expect(guard).toContain('WHERE NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e');
    expect(guard).toContain('e.ended_at IS NULL');
    expect(guard).toMatch(/IF v_missing IS DISTINCT FROM 0::bigint THEN/);
    expect(guard).toMatch(/RAISE EXCEPTION 'the genesis backfill left/);
    // The guard follows the backfill; a check that runs first checks nothing.
    expect(CODE.indexOf('DO $$')).toBeGreaterThan(
      CODE.indexOf('INSERT INTO public.cash_cluster_epoch')
    );
  });

  it('uses IS DISTINCT FROM, because a NULL count would pass an equality', () => {
    // `IF NOT (x = y)` is NULL when x is NULL, and plpgsql takes NULL as false.
    // The estate has lost a whole harness run to that shape.
    expect(CODE).not.toMatch(/IF v_missing (=|<>) 0/);
  });
});

describe('Phase 2 remediation: the event ledger takes its cluster epoch', () => {
  it('fills the epoch in a BEFORE INSERT trigger, where a DEFAULT cannot reach', () => {
    // A DEFAULT cannot read another row. 33 insert sites across the estate name
    // no epoch, and on the first bump each one would file its event under a
    // genesis epoch the cluster has left.
    expect(CODE).toMatch(
      /CREATE TRIGGER trg_cash_cluster_events_take_the_clusters_epoch\s+BEFORE INSERT ON public\.cash_cluster_events\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.fn_cash_cluster_event_takes_the_clusters_epoch\(\);/
    );
    expect(CODE).toContain(
      'DROP TRIGGER IF EXISTS trg_cash_cluster_events_take_the_clusters_epoch ON public.cash_cluster_events;'
    );
  });

  it('gives the trigger function a definer and a pinned search_path', () => {
    const fn = CODE.slice(
      CODE.indexOf(
        'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_event_takes_the_clusters_epoch()'
      ),
      CODE.indexOf('$fn$;') + 5
    );
    expect(fn).toContain('SECURITY DEFINER');
    expect(fn).toMatch(/SET search_path TO 'public', 'pg_temp'/);
  });

  it('keeps the definer out of every browser role', () => {
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_cash_cluster_event_takes_the_clusters_epoch() FROM PUBLIC, anon, authenticated;'
    );
  });

  it('obeys an author who named an epoch, by returning NEW before it reads anything', () => {
    // This is the whole narrowness of the trigger, and it is one deletable
    // statement. Without the early return the trigger overwrites an epoch the
    // caller chose deliberately - including a conversion writing the event that
    // ENDS an epoch, which must be filed under the epoch that ended, not under
    // the one the cluster has already moved to.
    expect(CODE).toContain(
      '  IF NEW.cluster_epoch IS DISTINCT FROM 0 THEN\n    RETURN NEW;\n  END IF;\n'
    );
    // And it only overwrites when the cluster has actually moved on.
    expect(CODE).toMatch(/IF v_epoch IS NOT NULL AND v_epoch <> 0 THEN/);
  });
});

describe('Phase 2 remediation: the drops are ordered so the file can be applied twice', () => {
  const CHILDREN = [
    'lightning_hand_player_sits_in_its_own_slot',
    'lightning_hand_player_belongs_to_its_hand',
    'lightning_hand_belongs_to_its_instance',
    'lightning_reservation_belongs_to_its_slot',
    'lightning_pool_slot_belongs_to_its_session',
  ];
  const IDENTITIES = [
    'lightning_hand_identity',
    'lightning_instance_identity',
    'lightning_pool_slot_identity',
    'lightning_pool_session_identity',
  ];
  const dropAt = (name: string) => CODE.indexOf(`DROP CONSTRAINT IF EXISTS ${name};`);

  it('drops every child key before the unique constraint that key points at', () => {
    // WITHOUT THIS THE MIGRATION CANNOT BE APPLIED TWICE, and a migration that
    // cannot be applied twice cannot be re-applied after a partial failure.
    // PostgreSQL refuses to drop a unique constraint an existing foreign key
    // depends on. On a re-run lightning_pool_slot_identity is the target of the
    // lightning_hand_player_sits_in_its_own_slot key that this same file added
    // on the first run, and the same is true of lightning_instance_identity and
    // lightning_hand_identity. So the drops are gathered in one head block,
    // children before parents, and the per-statement DROP IF EXISTS lines
    // further down are left in place as no-ops.
    //
    // Asserted by OFFSET rather than by presence: the statements exist either
    // way, and it is only where they sit relative to each other that decides
    // whether the second application succeeds.
    for (const c of CHILDREN) expect(dropAt(c), `${c} is never dropped`).toBeGreaterThan(-1);
    for (const i of IDENTITIES) expect(dropAt(i), `${i} is never dropped`).toBeGreaterThan(-1);
    const lastChild = Math.max(...CHILDREN.map(dropAt));
    const firstIdentity = Math.min(...IDENTITIES.map(dropAt));
    expect(lastChild).toBeLessThan(firstIdentity);
  });

  it('gathers the head-block drops before the first ADD CONSTRAINT of the file', () => {
    const firstAdd = CODE.indexOf('ADD CONSTRAINT lightning_');
    expect(firstAdd).toBeGreaterThan(-1);
    for (const n of [...CHILDREN, ...IDENTITIES]) expect(dropAt(n)).toBeLessThan(firstAdd);
  });
});

describe('Phase 2 remediation: the identity tuple grows an epoch', () => {
  it('re-creates all four identities by name', () => {
    for (const n of [
      'lightning_pool_session_identity',
      'lightning_pool_slot_identity',
      'lightning_instance_identity',
      'lightning_hand_identity',
    ]) {
      expect(added(n)).toContain('UNIQUE (');
    }
  });

  it('gives the two pool identities four columns, the epoch among them', () => {
    // A slot under a session from a different epoch satisfied every one of the
    // three-column keys 20260920235343 wrote. The epoch joins the tuple so the
    // database, and not the writer, is what refuses that row.
    for (const n of ['lightning_pool_session_identity', 'lightning_pool_slot_identity']) {
      const cols = tuple(added(n), 'UNIQUE');
      expect(cols).toEqual(['id', 'player_id', 'cluster_id', 'cluster_epoch']);
      expect(cols).toContain('cluster_epoch');
      expect(cols.length).toBe(4);
    }
  });

  it('anchors the two family roots to the epoch history itself', () => {
    for (const n of [
      'lightning_pool_session_runs_in_a_declared_epoch',
      'lightning_instance_runs_in_a_declared_epoch',
    ]) {
      const stmt = added(n);
      expect(tuple(stmt, 'FOREIGN KEY')).toEqual(['cluster_id', 'cluster_epoch']);
      expect(stmt).toContain('REFERENCES public.cash_cluster_epoch (cluster_id, epoch)');
      expect(stmt).toContain('ON DELETE RESTRICT');
    }
  });
});

describe('Phase 2 remediation: the hand family is joined', () => {
  const KEYS: Array<[string, string[], string, string[], string]> = [
    [
      'lightning_pool_slot_belongs_to_its_session',
      ['pool_session_id', 'player_id', 'cluster_id', 'cluster_epoch'],
      'lightning_pool_session',
      ['id', 'player_id', 'cluster_id', 'cluster_epoch'],
      'RESTRICT',
    ],
    [
      'lightning_reservation_belongs_to_its_slot',
      ['pool_slot_id', 'player_id', 'cluster_id', 'cluster_epoch'],
      'lightning_pool_slot',
      ['id', 'player_id', 'cluster_id', 'cluster_epoch'],
      'CASCADE',
    ],
    [
      'lightning_hand_belongs_to_its_instance',
      ['lightning_instance_id', 'cluster_id', 'cluster_epoch'],
      'lightning_instance',
      ['id', 'cluster_id', 'cluster_epoch'],
      'RESTRICT',
    ],
    [
      'lightning_hand_player_belongs_to_its_hand',
      ['hand_id', 'cluster_id', 'cluster_epoch'],
      'lightning_hand',
      ['hand_id', 'cluster_id', 'cluster_epoch'],
      'RESTRICT',
    ],
    [
      'lightning_hand_player_sits_in_its_own_slot',
      ['pool_slot_id', 'player_id', 'cluster_id', 'cluster_epoch'],
      'lightning_pool_slot',
      ['id', 'player_id', 'cluster_id', 'cluster_epoch'],
      'RESTRICT',
    ],
  ];

  it.each(KEYS)('%s references the whole tuple, not part of it', (name, cols, parent, pcols) => {
    const stmt = added(name);
    expect(tuple(stmt, 'FOREIGN KEY')).toEqual(cols);
    expect(stmt).toContain(`REFERENCES public.${parent} (${pcols.join(', ')})`);
  });

  it.each(KEYS)(
    '%s deletes the way its level of the model can afford',
    (name, _c, _p, _pc, act) => {
      // A hold is transient and dies with its table: CASCADE. Everything else is
      // a record, and a record is closed, not deleted: RESTRICT. A CASCADE on
      // lightning_hand_player_sits_in_its_own_slot would let a closed slot take
      // the hand history that names it, which is the rule "instance destruction
      // must never destroy hand history" one level down.
      expect(added(name)).toContain(`ON DELETE ${act}`);
    }
  );

  it('is exactly those five keys and the two that anchor the family roots', () => {
    const names = [...CODE.matchAll(/ADD CONSTRAINT (\w+)\s+FOREIGN KEY/g)].map((m) => m[1]);
    expect([...new Set(names)].sort()).toEqual(
      [
        ...KEYS.map(([n]) => n),
        'lightning_pool_session_runs_in_a_declared_epoch',
        'lightning_instance_runs_in_a_declared_epoch',
      ].sort()
    );
  });
});

describe('Phase 2 remediation: the participation row learns where it is', () => {
  it('adds cluster_id and cluster_epoch in one ALTER TABLE each', () => {
    // scripts/ci/check-migrations-applied.mjs pairs each added column with its
    // own ALTER TABLE. A comma-separated list would declare only the first, and
    // the second would never be checked against the live database again.
    expect(CODE).toMatch(
      /ALTER TABLE public\.lightning_hand_player\s+ADD COLUMN IF NOT EXISTS cluster_id uuid NOT NULL;/
    );
    expect(CODE).toMatch(
      /ALTER TABLE public\.lightning_hand_player\s+ADD COLUMN IF NOT EXISTS cluster_epoch integer NOT NULL;/
    );
    const alters = [...CODE.matchAll(/ALTER TABLE public\.\w+\s+ADD\s+COLUMN\b/gi)];
    expect(alters.length).toBe([...CODE.matchAll(/ADD\s+COLUMN\b/gi)].length);
  });

  it('gives neither column a default, because a default would invent an answer', () => {
    // The tables are empty, so NOT NULL with no default is free. It is also the
    // right shape: a participation row that cannot say which cluster it is in
    // is the defect being closed.
    expect(CODE).not.toMatch(/ADD COLUMN IF NOT EXISTS cluster_id uuid NOT NULL DEFAULT/);
    expect(CODE).not.toMatch(/ADD COLUMN IF NOT EXISTS cluster_epoch integer NOT NULL DEFAULT/);
  });

  it('keeps the epoch non-negative under a name a later migration can address', () => {
    expect(CODE).toContain(
      'ADD CONSTRAINT lightning_hand_player_epoch_nonneg CHECK (cluster_epoch >= 0)'
    );
  });
});

describe('Phase 2 remediation: the smaller corrections', () => {
  it('re-cuts the oldest-BB index per epoch and keeps NULLS FIRST', () => {
    // The old index served (cluster_id, last_bb_at, player_id) and so offered
    // BB candidates from a seating regime that had ended. NULLS FIRST is not
    // cosmetic: a slot that has never posted a big blind holds the OLDEST
    // unresolved obligation there is, so it must sort before every timestamp.
    expect(CODE).toContain('DROP INDEX IF EXISTS public.lightning_pool_slot_oldest_bb;');
    expect(CODE).toMatch(
      /CREATE INDEX IF NOT EXISTS lightning_pool_slot_oldest_bb\s+ON public\.lightning_pool_slot \(cluster_id, cluster_epoch, last_bb_at NULLS FIRST, player_id\)\s+WHERE closed_at IS NULL;/
    );
    expect(CODE.indexOf('DROP INDEX IF EXISTS public.lightning_pool_slot_oldest_bb;')).toBeLessThan(
      CODE.indexOf('CREATE INDEX IF NOT EXISTS lightning_pool_slot_oldest_bb')
    );
  });
});

describe('Phase 2 remediation: scope and safety', () => {
  it('is a single transaction', () => {
    expect((CODE.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((CODE.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
  });

  it('declares live proofs, every one of them a single parenthesised SELECT', () => {
    // The applied-check evaluates each proof as a scalar boolean expression.
    // A line that is not wrapped, or that carries a second statement, is not
    // something the checker can run, so it silently proves nothing.
    const proofs = [...SQL.matchAll(/--\s*@live-proof:\s*(.+?)\s*$/gim)].map((m) => m[1]);
    expect(proofs.length).toBeGreaterThanOrEqual(10);
    for (const p of proofs) {
      expect(p, p).toMatch(/^\(SELECT /);
      expect(p, p).toMatch(/\)$/);
      expect(p, p).not.toContain(';');
    }
  });

  it('starts no Phase 4 and no Phase 5 work: no population, no threshold, no conversion', () => {
    // Phase 4 is the population predicate and Phase 5 is the conversion. This
    // file is a schema repair: it makes those phases possible and performs
    // neither. A threshold constant or a cluster_mode write appearing here is
    // how a later phase arrives early, half-built and unreviewed.
    expect(CODE).not.toMatch(/population/i);
    expect(CODE).not.toMatch(/thresholds?/i);
    for (const n of ['18', '27', '12']) {
      expect(CODE, `threshold constant ${n} arrived early`).not.toMatch(new RegExp(`\\b${n}\\b`));
    }
    expect(CODE).not.toMatch(/UPDATE\s+public\.cash_games/i);
    expect(CODE).not.toMatch(/SET\s+cluster_mode/i);
  });
});
