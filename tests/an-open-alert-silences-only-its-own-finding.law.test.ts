/**
 * ===========================================================================
 *  LAW: AN OPEN ALERT SILENCES ONLY ITS OWN FINDING
 * ===========================================================================
 *
 * fn_ca_tournament_finished_but_not_completed (cron 304, every five minutes)
 * is the only thing on this database that can see a tournament whose final
 * bust has happened but which never reached COMPLETED, so its winner is
 * unpaid. It decided whether to raise with
 *
 *   SELECT EXISTS (SELECT 1 FROM public.financial_alerts fa
 *                   WHERE fa.source = 'fn_ca_tournament_finished_but_not_completed'
 *                     AND COALESCE(fa.resolved, false) = false) INTO v_open;
 *
 * so ANY open alert from its own source silenced EVERY later finding. Alert
 * 8c6ce084, raised 2026-09-08 17:15 about a tournament that COMPLETED six
 * minutes later, was never closed, and the detector said nothing for fourteen
 * days while it reported success 4,138 times. On 2026-09-22 it would have
 * named 17, 23, 1 and 4 stuck tournaments at the 14:00, 14:05, 14:10 and 15:05
 * ticks.
 *
 * 20260922160729 keys the decision on the tournament: a tournament is skipped
 * only when an open alert already names IT, through one function the detector
 * calls, and an alert closes when every tournament it names has COMPLETED.
 *
 * WHAT THIS LAW PINS
 *
 *   1. The fix: the per-tournament question, the re-measured closure, the
 *      both-direction verification the migration runs before it commits, and
 *      its live proofs. No new job.
 *   2. THE ONE THAT MATTERS LATER: from 20260922160729 no migration may define
 *      a function that raises into financial_alerts, ca_drift_incidents or
 *      ca_diamond_incidents and decides whether to raise with a guard - an
 *      EXISTS or a PERFORM over that table - that names no column saying what
 *      the finding is ABOUT. Source, severity, open/closed and time say who
 *      raised it, how bad and when; a guard built from those alone is the
 *      defect above, because one stale row silences every unrelated finding.
 *      A function that raises and repairs is judged too: the defect lives in
 *      the raise path, whatever else the function does.
 *   3. The detector is exercised against the shapes it refuses and allows, and
 *      against the two historical migrations that carried this defect, before
 *      it is trusted against the tree.
 *
 * WHAT IT DOES NOT JUDGE: whether the key a guard names is a good one (a
 * verdict or a kind is a key, not an entity; that is review's call), and a
 * body patched in place with pg_temp.ca_patch rather than defined.
 *
 * NOTE ON ASSERTING THE NEGATIVE: the fix's header and comments quote the
 * guard they retire, so every scan runs on a copy with SQL comments blanked.
 * The guard judge also blanks string literals: a source NAMED 'context' is a
 * literal, not the context column.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBetween, sliceDollarQuoted, sliceSqlStatement } from './helpers/sourceWindow';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FIX = '20260922160729_an_unfinished_finish_is_alerted_per_tournament.sql';
const FORWARD_GUARD_FROM = '20260922160729';
/** The migrations that installed the source-wide silence, both measured live. */
const INTRODUCED = '20260907045255_a_tournament_with_one_player_left_is_not_still_running.sql';
const CARRIED = '20260911062048_a_bust_is_ranked_by_when_it_happened.sql';

const read = (file: string): string => readFileSync(join(MIGRATIONS, file), 'utf8');

type Table = 'financial_alerts' | 'ca_drift_incidents' | 'ca_diamond_incidents';
const TABLES: readonly Table[] = ['financial_alerts', 'ca_drift_incidents', 'ca_diamond_incidents'];

/** Every column of each table (read from the live catalogue 2026-09-22), so a bare name can be told from a variable. */
const COLUMNS: Record<Table, readonly string[]> = {
  financial_alerts: [
    'id',
    'severity',
    'source',
    'message',
    'context',
    'resolved',
    'resolved_at',
    'created_at',
    'resolved_by',
    'resolution',
  ],
  ca_drift_incidents: [
    'id',
    'detected_at',
    'deadline_at',
    'classification',
    'severity',
    'layer',
    'status',
    'source',
    'dedupe_key',
    'union_id',
    'club_id',
    'entity_type',
    'entity_id',
    'table_id',
    'tournament_id',
    'hand_id',
    'settlement_id',
    'wallet_ids',
    'transaction_ids',
    'currency',
    'expected_amount',
    'actual_amount',
    'discrepancy_amount',
    'ledger_balanced',
    'suspected_cause',
    'auto_repair_status',
    'escalation_level',
    'past_target',
    'occurrences',
    'last_seen_at',
    'acknowledged_by',
    'acknowledged_at',
    'assigned_to',
    'root_cause',
    'correction_ref',
    'resolution',
    'resolved_by',
    'resolved_at',
    'metadata',
    'created_at',
    'closure_basis',
  ],
  ca_diamond_incidents: [
    'id',
    'occurred_at',
    'rule',
    'severity',
    'user_id',
    'amount',
    'writer',
    'db_role',
    'app_name',
    'detail',
    'resolved_at',
    'resolution',
  ],
};

/** The columns that say who raised a row, how bad it is, and whether and when it closed - never what it is about. */
const NOT_ABOUT: Record<Table, readonly string[]> = {
  financial_alerts: [
    'id',
    'severity',
    'source',
    'resolved',
    'resolved_at',
    'created_at',
    'resolved_by',
    'resolution',
  ],
  ca_drift_incidents: [
    'id',
    'detected_at',
    'deadline_at',
    'classification',
    'severity',
    'layer',
    'status',
    'source',
    'currency',
    'entity_type',
    'auto_repair_status',
    'escalation_level',
    'past_target',
    'occurrences',
    'last_seen_at',
    'acknowledged_by',
    'acknowledged_at',
    'assigned_to',
    'root_cause',
    'correction_ref',
    'resolution',
    'resolved_by',
    'resolved_at',
    'created_at',
    'closure_basis',
  ],
  ca_diamond_incidents: [
    'id',
    'occurred_at',
    'rule',
    'severity',
    'writer',
    'db_role',
    'app_name',
    'resolved_at',
    'resolution',
  ],
};

/** How a function raises into each table: an insert, or the table's own raise door. */
const RAISES: Record<Table, RegExp> = {
  financial_alerts:
    /\bINSERT\s+INTO\s+(?:public\.)?financial_alerts\b|\bfn_raise_(?:server_)?financial_alert\s*\(/i,
  ca_drift_incidents:
    /\bINSERT\s+INTO\s+(?:public\.)?ca_drift_incidents\b|\bfn_ca_raise_drift_incident\s*\(/i,
  ca_diamond_incidents:
    /\bINSERT\s+INTO\s+(?:public\.)?ca_diamond_incidents\b|\bfn_ca_diamond_incident\s*\(/i,
};

/**
 * `sql` with every SQL comment blanked and everything else left where it was.
 * Length and newlines are preserved. Dollar quotes are transparent: a
 * function body is code, and a comment inside it is still a comment.
 */
export const withoutComments = (sql: string): string => {
  const out = sql.split('');
  const n = sql.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < n) {
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      const to = nl < 0 ? n : nl;
      blank(i, to);
      i = to;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2);
      const to = close < 0 ? n : close + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
};

/** The contents of every single-quoted literal blanked, quotes kept, length preserved. */
const withoutLiterals = (code: string): string =>
  code.replace(/'(?:[^']|'')*'/g, (m) => `'${' '.repeat(m.length - 2)}'`);

/** Each function a migration DEFINES, bounded by its own dollar-quote tag. DO blocks define nothing. */
export const functionBodies = (sql: string): Array<{ name: string; body: string }> => {
  const code = withoutComments(sql);
  const heads = [
    ...code.matchAll(
      /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?[A-Za-z_][A-Za-z0-9_]*"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi
    ),
  ];
  const out: Array<{ name: string; body: string }> = [];
  heads.forEach((h, k) => {
    const from = (h.index ?? 0) + h[0].length;
    const until = k + 1 < heads.length ? (heads[k + 1].index ?? code.length) : code.length;
    const as = /\bAS\s+(\$[A-Za-z0-9_]*\$)/gi;
    as.lastIndex = from;
    const a = as.exec(code);
    if (!a || a.index >= until) return;
    const open = a.index + a[0].length;
    const close = code.indexOf(a[1], open);
    if (close < 0) return;
    out.push({ name: h[1].toLowerCase(), body: withoutLiterals(code.slice(open, close)) });
  });
  return out;
};

/** The index of the parenthesis that closes the one at `open`. Literals are already blank. */
const closingParen = (s: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length;
};

/** Every existence question a body asks: each EXISTS (...) group and each PERFORM statement. */
const guardsIn = (body: string): string[] => {
  const out: string[] = [];
  for (const m of body.matchAll(/\bEXISTS\s*\(/gi)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    out.push(body.slice(open + 1, closingParen(body, open)));
  }
  for (const m of body.matchAll(/\bPERFORM\b/gi)) {
    const semi = body.indexOf(';', m.index ?? 0);
    out.push(body.slice(m.index ?? 0, semi < 0 ? body.length : semi));
  }
  return out;
};

const FROM_TABLE =
  /\bFROM\s+(?:public\s*\.\s*)?(financial_alerts|ca_drift_incidents|ca_diamond_incidents)\b(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/i;
const NOT_AN_ALIAS = new Set([
  'where',
  'join',
  'left',
  'right',
  'inner',
  'cross',
  'full',
  'natural',
  'on',
  'using',
  'group',
  'order',
  'limit',
  'offset',
  'fetch',
  'union',
  'except',
  'intersect',
  'for',
  'having',
  'window',
]);

/** The table a guard reads if it names nothing that says what the finding is about; otherwise null. */
export const namesNothingAbout = (guard: string, raisesInto: ReadonlySet<Table>): Table | null => {
  const f = FROM_TABLE.exec(guard);
  if (!f) return null;
  const table = f[1].toLowerCase() as Table;
  if (!raisesInto.has(table)) return null;
  const alias = f[2] && !NOT_AN_ALIAS.has(f[2].toLowerCase()) ? f[2].toLowerCase() : null;
  const at = guard.search(/\bWHERE\b/i);
  const where = at < 0 ? '' : guard.slice(at);
  const named = new Set<string>();
  for (const q of where.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const owner = q[1].toLowerCase();
    if (owner === alias || owner === table) named.add(q[2].toLowerCase());
  }
  for (const b of where.matchAll(/(?<![.\w])([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\.)/g)) {
    const c = b[1].toLowerCase();
    if (COLUMNS[table].includes(c)) named.add(c);
  }
  return [...named].some((c) => !NOT_ABOUT[table].includes(c)) ? null : table;
};

/**
 * Every `function on table` in a migration that raises into an alert or
 * incident table and decides whether to with a guard over that table that
 * names nothing the finding is about.
 */
export const sourceOnlyGuards = (sql: string): string[] => {
  const hits = new Set<string>();
  for (const { name, body } of functionBodies(sql)) {
    const raisesInto = new Set(TABLES.filter((t) => RAISES[t].test(body)));
    if (raisesInto.size === 0) continue;
    for (const guard of guardsIn(body)) {
      const table = namesNothingAbout(guard, raisesInto);
      if (table) hits.add(`${name} on ${table}`);
    }
  }
  return [...hits].sort();
};

const fn = (name: string, body: string): string =>
  `CREATE OR REPLACE FUNCTION public.${name}() RETURNS void LANGUAGE plpgsql AS $function$\n${body}\n$function$;`;

describe('an open alert silences only its own finding', () => {
  describe('the detector refuses the shapes that silence unrelated findings', () => {
    it('an insert gated on the source and the open flag alone', () => {
      const sql = fn(
        'fn_sample_check',
        `BEGIN
          INSERT INTO public.financial_alerts (severity, source, message, context)
          SELECT 'critical', 'fn_sample_check', 'x', '{}'::jsonb
           WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                              WHERE fa.source = 'fn_sample_check' AND fa.resolved IS NOT TRUE);
        END`
      );
      expect(sourceOnlyGuards(sql)).toEqual(['fn_sample_check on financial_alerts']);
    });

    it('a time window is not a key', () => {
      const sql = fn(
        'fn_sample_selftest',
        `BEGIN
          IF NOT EXISTS (SELECT 1 FROM financial_alerts
                          WHERE source = 'fn_sample_selftest' AND created_at > now() - interval '20 hours') THEN
            INSERT INTO financial_alerts (severity, source, message) VALUES ('critical', 'fn_sample_selftest', 'x');
          END IF;
        END`
      );
      expect(sourceOnlyGuards(sql)).toEqual(['fn_sample_selftest on financial_alerts']);
    });

    it('the same shape on the incident board, raised through its door', () => {
      const sql = fn(
        'fn_sample_watch',
        `BEGIN
          IF NOT EXISTS (SELECT 1 FROM public.ca_drift_incidents i
                          WHERE i.source = 'fn_sample_watch' AND i.status <> 'resolved') THEN
            PERFORM public.fn_ca_raise_drift_incident('fn_sample_watch', 'unknown', 'critical', 'k');
          END IF;
        END`
      );
      expect(sourceOnlyGuards(sql)).toEqual(['fn_sample_watch on ca_drift_incidents']);
    });

    it('a PERFORM guard in front of the raise door', () => {
      const sql = fn(
        'fn_sample_guard',
        `BEGIN
          PERFORM 1 FROM public.financial_alerts WHERE source = 'fn_sample_guard' AND NOT resolved;
          IF NOT FOUND THEN
            PERFORM public.fn_raise_financial_alert('critical', 'fn_sample_guard', 'x', '{}'::jsonb);
          END IF;
        END`
      );
      expect(sourceOnlyGuards(sql)).toEqual(['fn_sample_guard on financial_alerts']);
    });

    it('a literal that spells a column name, or a variable field, is not a key', () => {
      const sql = fn(
        'fn_sample_literal',
        `DECLARE v_row record;
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                          WHERE fa.source = 'context' AND NOT fa.resolved
                            AND v_row.context IS NOT NULL) THEN
            INSERT INTO public.financial_alerts (severity, source, message) VALUES ('critical', 'context', 'x');
          END IF;
        END`
      );
      expect(sourceOnlyGuards(sql)).toEqual(['fn_sample_literal on financial_alerts']);
    });

    it('and it sees both historical migrations that installed the silence', () => {
      expect(sourceOnlyGuards(read(INTRODUCED))).toContain(
        'fn_ca_tournament_finished_but_not_completed on financial_alerts'
      );
      expect(sourceOnlyGuards(read(CARRIED))).toContain(
        'fn_ca_tournament_finished_but_not_completed on financial_alerts'
      );
    });
  });

  describe('and allows the shapes that keep one open alert per finding', () => {
    it('a guard that names the entity', () => {
      const sql = fn(
        'fn_sample_keyed',
        `DECLARE v_row record;
        BEGIN
          INSERT INTO public.financial_alerts (severity, source, message, context)
          SELECT 'critical', 'fn_sample_keyed', 'x', jsonb_build_object('tournament_id', v_row.id)
           WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                              WHERE fa.source = 'fn_sample_keyed' AND fa.resolved IS NOT TRUE
                                AND fa.context->>'tournament_id' = v_row.id::text);
        END`
      );
      expect(sourceOnlyGuards(sql)).toEqual([]);
    });

    it('a guard on an incident key, or a table this function does not raise into', () => {
      const sql = fn(
        'fn_sample_board',
        `BEGIN
          IF NOT EXISTS (SELECT 1 FROM ca_drift_incidents WHERE dedupe_key = 'k' AND status <> 'resolved')
             AND NOT EXISTS (SELECT 1 FROM financial_alerts WHERE source = 'x' AND NOT resolved) THEN
            PERFORM public.fn_ca_raise_drift_incident('fn_sample_board', 'unknown', 'critical', 'k');
          END IF;
        END`
      );
      expect(sourceOnlyGuards(sql)).toEqual([]);
    });

    it('a report that raises nothing, a DO block, and a comment quoting the old guard', () => {
      const report = fn(
        'fn_sample_report',
        `BEGIN
          PERFORM 1 WHERE EXISTS (SELECT 1 FROM financial_alerts WHERE source = 'x' AND NOT resolved);
        END`
      );
      const block = `DO $v$ BEGIN
          IF EXISTS (SELECT 1 FROM financial_alerts WHERE source = 'x' AND NOT resolved) THEN
            INSERT INTO financial_alerts (severity, source, message) VALUES ('info', 'x', 'probe');
          END IF;
        END $v$;`;
      const quoted = fn(
        'fn_sample_quoted',
        `BEGIN
          -- was: NOT EXISTS (SELECT 1 FROM financial_alerts WHERE source = 'x' AND NOT resolved)
          INSERT INTO financial_alerts (severity, source, message) VALUES ('critical', 'x', 'y');
        END`
      );
      expect(sourceOnlyGuards(report)).toEqual([]);
      expect(sourceOnlyGuards(block)).toEqual([]);
      expect(sourceOnlyGuards(quoted)).toEqual([]);
    });
  });

  describe('the fix (20260922160729)', () => {
    const SQL = read(FIX);
    const CODE = withoutComments(SQL);

    it('is itself clean', () => {
      expect(sourceOnlyGuards(SQL)).toEqual([]);
    });

    it('asks, per tournament, whether an open alert already names it', () => {
      const question = sliceSqlStatement(
        CODE,
        'CREATE OR REPLACE FUNCTION public.fn_ca_finished_not_completed_open_alert(p_tournament_id uuid)'
      );
      expect(question).toContain("fa.source = 'fn_ca_tournament_finished_but_not_completed'");
      expect(question).toContain('AND NOT fa.resolved');
      expect(question).toMatch(
        /fa\.context->'tournaments' @> jsonb_build_array\(\s*jsonb_build_object\('tournament_id', p_tournament_id\)\)/
      );
      // Bounded by the statement after it: the message itself contains a semicolon.
      const raise = sliceBetween(
        CODE,
        'INSERT INTO public.financial_alerts (severity, source, message, context)',
        'GET DIAGNOSTICS v_raised'
      );
      expect(raise).toContain(
        "WHERE public.fn_ca_finished_not_completed_open_alert((s->>'tournament_id')::uuid) IS NULL"
      );
      expect(raise).toContain("'tournament_id', s->'tournament_id'");
      expect(raise).toContain("'tournaments', jsonb_build_array(s)");
      const detector = sliceSqlStatement(
        CODE,
        'CREATE OR REPLACE FUNCTION public.fn_ca_tournament_finished_but_not_completed(p_minutes integer DEFAULT 15)'
      );
      expect(detector, 'the source-wide silence is gone').not.toMatch(/\bv_open\b/);
      expect(detector).not.toMatch(/COALESCE\(fa\.resolved, false\) = false/);
    });

    it('keeps the threshold, the severity and the grants it had', () => {
      const detector = sliceSqlStatement(
        CODE,
        'CREATE OR REPLACE FUNCTION public.fn_ca_tournament_finished_but_not_completed(p_minutes integer DEFAULT 15)'
      );
      expect(detector).toContain('GREATEST(COALESCE(p_minutes, 15), 1)');
      expect(detector).toContain("SELECT 'critical',");
      expect(detector).toContain('SECURITY DEFINER');
      expect(CODE).toMatch(
        /REVOKE ALL ON FUNCTION public\.fn_ca_finished_not_completed_open_alert\(uuid\)\s+FROM PUBLIC, anon, authenticated;/
      );
    });

    it('closes a finding once every tournament it names has COMPLETED, and only then', () => {
      const closure = sliceBetween(CODE, 'WITH named AS (', 'GET DIAGNOSTICS v_resolved');
      expect(closure).toContain("HAVING bool_and(COALESCE(n.status = 'COMPLETED', false))");
      expect(closure).toContain('resolved    = true');
      expect(closure).toContain('payout row(s) totalling');
      expect(closure).toContain('AND NOT fa.resolved;');
    });

    it('proves both directions before it commits, in a savepoint that is always rolled back', () => {
      const verify = sliceDollarQuoted(CODE, '$verify$');
      expect(verify).toContain("VALUES ('info', 'fn_ca_tournament_finished_but_not_completed',");
      expect(verify).toContain('fn_ca_finished_not_completed_open_alert(v_unrelated) IS NOT NULL');
      expect(verify).toContain(
        'fn_ca_finished_not_completed_open_alert(v_named) IS DISTINCT FROM v_probe'
      );
      expect(verify).toContain("RAISE EXCEPTION 'ca_verify_rollback';");
      expect(verify).toContain("IF SQLERRM <> 'ca_verify_rollback' THEN");
      expect(verify).toContain('the probe alert survived its rollback');
      const live = sliceDollarQuoted(CODE, '$live$');
      expect(live.split('public.fn_ca_tournament_finished_but_not_completed(15)').length - 1).toBe(
        2
      );
      expect(live).toContain('are named by more than one open alert');
      expect(live).toContain('still name only COMPLETED tournaments after a run');
    });

    it('adds no job and declares its live proofs', () => {
      expect(CODE).not.toMatch(/cron\.schedule\s*\(/i);
      expect(SQL.match(/^-- @live-proof: .+$/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(
        [...SQL].filter((ch) => (ch.codePointAt(0) ?? 0) > 127),
        'ASCII only'
      ).toEqual([]);
    });
  });

  it('from 20260922160729, no migration defines a raiser whose guard names only its source', () => {
    const offenders = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f >= FORWARD_GUARD_FROM)
      .flatMap((f) => sourceOnlyGuards(read(f)).map((hit) => `${f}: ${hit}`));
    expect(
      offenders,
      'Key the guard on what the finding is about - a tournament, a player, a lock, a dedupe key - so an ' +
        'open alert silences only its own finding. See 20260922160729 and docs/laws.d/' +
        'an-open-alert-silences-only-its-own-finding.md.\n' +
        offenders.join('\n')
    ).toEqual([]);
  });
});
