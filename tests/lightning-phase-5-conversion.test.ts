/**
 * LIGHTNING 2.0 PHASE 5: THE ATOMIC MUST-MOVE -> LIGHTNING CONVERSION, AND THE
 * TWO FUNCTIONS THAT HAD TO BE TAUGHT TO STAND DOWN.
 *
 * 20260921151618 implements the specification's twenty-four-step LIGHTNING
 * TRANSITION as three SECURITY DEFINER functions, one durable record, one halt
 * flag the engine reads, and THREE ASSERTED SUBSTITUTIONS into function bodies
 * this file must not retype. It also re-cuts two functions it did not invent -
 * fn_cash_cluster_live_eligible, which is the number that AUTHORISES a
 * conversion, and fn_cash_cluster_population, the breakdown an operator reads
 * beside it - onto ONE membership predicate, because both decided who belongs
 * to a Cluster using NULLABLE columns and therefore silently dropped whole
 * boards. Everything below is a static reading of that
 * migration. The harness `scripts/dev/test-lightning-phase5-conversion.sh`
 * proves the same claims against a running catalogue and a running estate; this
 * file proves the ones a catalogue cannot see, chiefly ORDERING - which
 * statement happens before which - because a function that does the right
 * things in the wrong order applies, compiles, and passes every read-back the
 * migration can take of itself.
 *
 * THE DESIGN IN ONE SENTENCE: THE SEAT IS THE ANCHOR. `table_seats` is never
 * written. The pool is an overlay in `lightning_pool_session` pointing at the
 * `cash_player_session` the seat already had, so stack, baseline, stay clock,
 * rejoin obligation, rake history and cluster membership are unchanged by
 * construction rather than by enforcement. F12 - "no money moves as a result of
 * this transition" - is not so much checked as made unreachable.
 *
 * WHY THIS FILE DOES NOT USE THE SIBLING'S ONE-LINE COMMENT STRIP.
 * tests/lightning-phase-4-remediation.test.ts strips comments with a single
 * regex replace of everything from a double dash to the end of its line, which
 * is right for a migration whose string literals contain no comment marker.
 * This migration's literals DO CONTAIN ONE, in two places: sections 6
 * and 7 build replacement SQL out of quoted lines that begin `-- LIGHTNING 2.0
 * PHASE 5`, and the post-apply read-back passes `'--[^' || chr(10) || ']*'` to
 * regexp_replace. A regex strip eats both and leaves a corrupted body behind,
 * so the scan below is literal-aware. It is asserted to be doing work, in both
 * directions, in section 2 - including against controls that prove it is not
 * merely blanking everything.
 *
 * LIGHTNING_P5_MIGRATION overrides the file under test, so mutation testing -
 * copying the migration to a scratch directory, breaking one line of the copy
 * and watching this suite go red - never has to touch the migration in the
 * repository. It is the same mechanism its siblings take as
 * LIGHTNING_P3R_MIGRATION, LIGHTNING_P4_MIGRATION and LIGHTNING_P4R_MIGRATION.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const FILE = '20260921151618_lightning_phase_5_the_conversion_is_one_transaction_and_the_.sql';
const MIGRATION = process.env.LIGHTNING_P5_MIGRATION ?? path.join(MIGRATIONS, FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');

/**
 * One left-to-right scan producing both stripped forms at once.
 *
 *   `code` - line comments removed, newlines and every literal kept.
 *   `biz`  - the same, with single-quoted literals blanked to spaces of the
 *            same length, so offsets survive and a rule about CODE cannot be
 *            satisfied by a sentence that happens to sit inside quotes.
 *
 * A `--` inside a literal is NOT a comment, and a dollar-quote delimiter is
 * transparent: the SQL inside `$fn$ ... $fn$` and `$q$ ... $q$` is code and is
 * scanned as code, which is the whole point - two of the three functions under
 * test live inside dollar quotes.
 */
function scan(sql: string): { code: string; biz: string } {
  let code = '';
  let biz = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j++;
      }
      const lit = sql.slice(i, Math.min(j + 1, n));
      code += lit;
      biz += `'${' '.repeat(Math.max(0, lit.length - 2))}'`;
      i = j + 1;
      continue;
    }
    const dollar = /^\$\w*\$/.exec(sql.slice(i, i + 40));
    if (dollar) {
      code += dollar[0];
      biz += dollar[0];
      i += dollar[0].length;
      continue;
    }
    code += sql[i];
    biz += sql[i];
    i++;
  }
  return { code, biz };
}

const { code: CODE, biz: BIZ } = scan(SQL);

/** Single-quoted literals blanked, length preserved. Used on spans. */
const blankLiterals = (s: string): string => scan(s).biz;

/** Whitespace-normalised: one space per run, ends trimmed. */
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

const count = (hay: string, re: RegExp): number => (hay.match(re) ?? []).length;

/** One span of text, from an anchor to the end of its terminator. '' if absent. */
function span(hay: string, from: string, to: string): string {
  const a = hay.indexOf(from);
  if (a < 0) return '';
  const b = hay.indexOf(to, a + from.length);
  return b < 0 ? '' : hay.slice(a, b + to.length);
}

/**
 * EVERY FUNCTION THIS FILE WRITES OUT, DISCOVERED RATHER THAN LISTED. The grant
 * completeness check below is driven off this, so a fourth function added to
 * this migration later cannot slip past ungranted by simply not being in a list
 * somebody remembered to extend. `raw` is the body as written; `body` is the
 * same with comments gone; `biz` also has its literals blanked.
 */
const FUNCTIONS: {
  name: string;
  argTypes: string;
  attrs: string;
  raw: string;
  body: string;
  biz: string;
}[] = [
  ...SQL.matchAll(
    /CREATE OR REPLACE FUNCTION\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*RETURNS\s+([\s\S]*?)\bAS\s+(\$\w*\$)([\s\S]*?)\4;/g
  ),
].map((m) => {
  const s = scan(m[5]);
  return {
    name: m[1],
    argTypes: m[2]
      .split(',')
      .map((a) =>
        flat(a)
          .replace(/\s+DEFAULT\s+[\s\S]*$/i, '')
          .split(/\s+/)
          .slice(1)
          .join(' ')
      )
      .join(', '),
    attrs: flat(m[3]),
    raw: m[5],
    body: s.code,
    biz: s.biz,
  };
});

const fnOf = (name: string) => {
  const f = FUNCTIONS.find((x) => x.name === name);
  if (!f) throw new Error(`the migration no longer writes out public.${name}`);
  return f;
};

const BEGIN_ON = fnOf('fn_cash_cluster_begin_pending_on');
const ABORT = fnOf('fn_cash_cluster_abort_pending_on');
const COMMIT_ON = fnOf('fn_cash_cluster_commit_lightning');
const CONVERSION = [BEGIN_ON, ABORT, COMMIT_ON];

/**
 * THE READER THIS MIGRATION RE-CUT BUT DID NOT INVENT, AND WHY IT IS NOT LIKE
 * THE OTHER THREE.
 *
 * fn_cash_cluster_live_eligible is the number that AUTHORISES a conversion: the
 * verdict the lobby embeds and the threshold the whole of Phase 5 hangs off.
 * 20260921064717 created it SECURITY INVOKER, LANGUAGE sql, STABLE, and this
 * migration re-creates it in place with CREATE OR REPLACE to put it on the one
 * coalesced membership predicate. CREATE OR REPLACE keeps the OID, so its
 * grants and its Phase 4 COMMENT survive untouched - which is why the rules
 * below about definer-ness and about COMMENT are stated over the WRITERS and
 * not over every function this file happens to write out. A blanket rule here
 * would either demand a privilege escalation on a read-only counter or demand a
 * second copy of a COMMENT that can then drift from the first.
 */
const LIVE_ELIGIBLE = fnOf('fn_cash_cluster_live_eligible');

/** The three that WRITE, and are therefore SECURITY DEFINER plpgsql VOLATILE. */
const WRITERS = CONVERSION;

/** Every @live-proof expression, in file order, and the raw lines they came from. */
const PROOF_LINES = SQL.split('\n').filter((l) => /^--\s*@live-proof:/.test(l));
const PROOFS = [...SQL.matchAll(/--\s*@live-proof:\s*(.+?)\s*$/gim)].map((m) => m[1]);

/** Parentheses balance, with string literals blanked first so a `\(` inside a
 *  quoted regex cannot be read as structure. */
const balanced = (expr: string): boolean => {
  let depth = 0;
  for (const c of blankLiterals(expr)) {
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
};

/** The DO blocks, keyed by their dollar tag, comments already gone. */
const doBlock = (tag: string): string => span(CODE, `DO $${tag}$`, `END $${tag}$;`);

/** One job of the workflow, from its key to the next thing at job indent. */
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const jobBlock = (name: string): string => {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
};

/** Any write to a seat, in any of the three spellings a writer would reach for. */
const SEAT_WRITE = /\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+(?:public\.)?table_seats\b/i;

// ===========================================================================
//  1. THE SHAPE OF THE CHANGE
// ===========================================================================

describe('Phase 5: one transaction, one lock timeout, one ADD COLUMN per ALTER TABLE', () => {
  it('is exactly one transaction with a lock timeout, as the production DDL policy requires', () => {
    // Every DDL statement fires Supabase's schema-cache reload, which takes
    // about 28 seconds on this database. This file carries two ALTER TABLEs, a
    // CREATE TABLE, five constraints, three indexes and three functions; loose,
    // that is a quarter of an hour of reloads. Counted over CODE rather than
    // SQL, because the plpgsql bodies open with a bare `BEGIN` and sections 6
    // and 7 build replacement SQL whose first quoted line is the string
    // 'BEGIN' - neither is a transaction and neither must be counted as one.
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE).toContain("SET LOCAL lock_timeout = '8s';");
    expect(CODE).not.toMatch(/^ROLLBACK;$/m);
    // A presence beside the counts, so a file containing nothing at all could
    // not satisfy them.
    // FOUR, NOT THREE. The fourth is fn_cash_cluster_live_eligible, which this
    // migration did not invent and does re-cut: it is the number that decides
    // whether a Cluster may convert at all, and it carried the uncoalesced
    // membership predicate this file exists to remove. A Cluster whose players
    // sat on a NULL-status or NULL-lifecycle board was told threshold_not_reached
    // however many people were playing on it, and any conversion it did make
    // wrote a short trigger_population into the audit record.
    expect(count(CODE, /CREATE OR REPLACE FUNCTION/g)).toBe(4);
    expect(FUNCTIONS.length, 'the function parser found nothing to check').toBe(4);
    expect(FUNCTIONS.map((f) => f.name).sort()).toEqual(
      [
        'fn_cash_cluster_abort_pending_on',
        'fn_cash_cluster_begin_pending_on',
        'fn_cash_cluster_commit_lightning',
        'fn_cash_cluster_live_eligible',
      ].sort()
    );
  });

  it('adds one column per ALTER TABLE, and both are IF NOT EXISTS', () => {
    // A multi-clause ALTER rewrites its intent into one catalogue event and a
    // reviewer reading the diff cannot see which clause failed. The rule is
    // asserted per statement rather than as a total, so a third column added
    // later cannot be folded into an existing ALTER to save a reload.
    const alters = [...CODE.matchAll(/ALTER TABLE[\s\S]*?;/g)].map((m) => m[0]);
    expect(alters.length, 'the ALTER TABLE parser found nothing').toBeGreaterThanOrEqual(7);
    for (const a of alters) {
      expect(
        count(a, /ADD COLUMN/g),
        `at most one ADD COLUMN per ALTER TABLE: ${flat(a)}`
      ).toBeLessThanOrEqual(1);
      expect(a, `a multi-clause ALTER TABLE: ${flat(a)}`).not.toMatch(/ADD COLUMN[\s\S]*,\s*ADD\b/);
    }
    expect(alters.filter((a) => /ADD COLUMN/.test(a)).length).toBe(2);
    // Re-appliability. An ALTER that is not IF NOT EXISTS applies exactly once.
    expect(CODE).toContain(
      'ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS dealing_halted_at timestamptz;'
    );
    expect(CODE).toContain(
      'ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS dealing_halted_reason text;'
    );
    expect(CODE).toContain('CREATE TABLE IF NOT EXISTS public.cash_cluster_conversion');
    expect(count(CODE, /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/g)).toBe(3);
    expect(CODE, 'an index without IF NOT EXISTS applies exactly once').not.toMatch(
      /CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/
    );
    expect(CODE).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|INDEX)\b/i);
  });

  it('guards EVERY ADD CONSTRAINT with an existence check on its own name', () => {
    // ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS in PostgreSQL 17, so
    // an unguarded one makes the whole file apply exactly once - which an
    // earlier cut of this migration did. Every one is therefore wrapped in a
    // DO block that asks pg_constraint for its own conname first, and the
    // pairing is checked by NAME rather than by counting blocks: a guard that
    // tested for a different constraint would be no guard at all.
    const guards = [...CODE.matchAll(/DO \$c\$[\s\S]*?END \$c\$;/g)].map((m) => ({
      text: m[0],
      start: m.index ?? -1,
      end: (m.index ?? -1) + m[0].length,
    }));
    const adds = [...CODE.matchAll(/ADD CONSTRAINT (\w+)/g)];
    expect(adds.length, 'this migration has stopped adding constraints').toBeGreaterThanOrEqual(5);
    for (const a of adds) {
      const at = a.index ?? -1;
      const g = guards.find((b) => at > b.start && at < b.end);
      expect(g, `ADD CONSTRAINT ${a[1]} is not inside an existence-checked DO block`).toBeTruthy();
      expect(g?.text, `${a[1]} is guarded, but not on its own name`).toContain(
        'FROM pg_constraint'
      );
      expect(g?.text, `${a[1]} is guarded by a check for a different constraint`).toContain(
        `conname = '${a[1]}'`
      );
      expect(g?.text).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/);
    }
    // And the guards are all consumed, so a DO block that guards nothing - the
    // shape a copy-paste leaves behind - is caught too.
    for (const g of guards) {
      expect(g.text, 'a guard block that adds no constraint').toMatch(/ADD CONSTRAINT/);
    }
  });
});

// ===========================================================================
//  2. THE STRIPS ARE PROVEN TO BE DOING WORK, IN BOTH DIRECTIONS
// ===========================================================================

describe('Phase 5: comments and literals are blanked, and the blanking is load-bearing', () => {
  it('treats a comment marker inside a literal as text, which this migration needs', () => {
    // NON-VACUITY FIRST. If no literal in this migration contained a comment
    // marker, the literal-aware scan would be over-engineering and the naive
    // regex strip the sibling uses would be correct. Sections 6 and 7 build
    // their replacement SQL out of quoted lines that begin with `--`, and the
    // read-back hands regexp_replace a comment pattern as a literal, so the
    // naive strip would silently destroy both.
    expect(SQL, 'no literal here carries a comment marker any more').toMatch(
      /'\s+-- LIGHTNING 2\.0 PHASE 5/
    );
    expect(SQL).toContain("'--[^' || chr(10) || ']*'");
    // The scan keeps them, and the naive strip does not. Stated as a pair so
    // that neither half can be read as an accident.
    expect(CODE).toContain("'--[^' || chr(10) || ']*'");
    expect(SQL.replace(/--[^\n]*/g, '')).not.toContain("'--[^' || chr(10) || ']*'");
    expect(CODE).toMatch(/'\s+-- LIGHTNING 2\.0 PHASE 5/);
  });

  it('removes real comments and blanks real literals without touching real code', () => {
    // THE CONTROLS. A strip that blanked everything would satisfy every absence
    // assertion in this file, so both strips are run over a probe carrying all
    // three forms of the same forbidden string - as code, as a comment, and as
    // a literal - and each is asserted to survive or vanish where it should.
    const probe =
      "UPDATE public.table_seats SET stack = 0; -- UPDATE table_seats\nSELECT 'UPDATE table_seats';\n";
    const p = scan(probe);
    expect(p.code, 'the strip ate real code').toContain('UPDATE public.table_seats SET stack = 0;');
    expect(p.code, 'the comment survived the strip').not.toContain('-- UPDATE table_seats');
    expect(count(p.code, /UPDATE table_seats/g), 'the literal was blanked by the wrong pass').toBe(
      1
    );
    expect(p.biz, 'blanking the literals ate real code').toContain(
      'UPDATE public.table_seats SET stack = 0;'
    );
    expect(count(p.biz, /UPDATE table_seats/g), 'a literal survived the blanking').toBe(0);
    expect(p.biz.length, 'blanking changed the offsets').toBe(p.code.length);
    // An escaped quote does not end a literal, which is how every COMMENT ON in
    // this file spells an apostrophe.
    expect(scan("SELECT 'it''s -- fine', 1;\n").code).toBe("SELECT 'it''s -- fine', 1;\n");
  });

  it('is doing work on this migration in both directions, measured rather than assumed', () => {
    // THE COMMENT STRIP, ON A REAL BODY. fn_cash_cluster_begin_pending_on names
    // table_seats exactly once, in a comment explaining why a pending seat move
    // has to be cancelled. Raw, the body mentions the table; stripped, it does
    // not mention it at all. If that comment is ever removed the first line
    // goes red and this paragraph stops being true, which is the point.
    expect(BEGIN_ON.raw, 'the begin body no longer names table_seats in prose').toMatch(
      /\btable_seats\b/
    );
    expect(BEGIN_ON.body, 'the comment strip is not removing the prose it claims to').not.toMatch(
      /\btable_seats\b/
    );
    expect(
      count(COMMIT_ON.raw, /\btable_seats\b/g),
      'the commit body stopped discussing the table it reads'
    ).toBeGreaterThan(count(COMMIT_ON.body, /\btable_seats\b/g));

    // THE LITERAL BLANK, ON THE REAL FILE. The migration's own post-apply
    // read-back quotes the forbidden forms as a regex - `UPDATE table_seats` is
    // in there verbatim, inside quotes - so this same rule run against CODE is
    // FALSE, and only the blanked form can carry it. Three @live-proof lines in
    // this project have already gone false for exactly this reason, and a
    // fourth went false because a COMMENT ON body containing the words "granted
    // to authenticated" made a grant-safety regex fire on correct code.
    expect(
      CODE,
      'the read-back no longer quotes the forbidden form, so BIZ proves nothing'
    ).toMatch(SEAT_WRITE);
    expect(BIZ, 'something in this file really does write a seat').not.toMatch(SEAT_WRITE);
  });
});

// ===========================================================================
//  3. THE SEAT IS THE ANCHOR: NOTHING HERE WRITES table_seats
// ===========================================================================

describe('Phase 5: not one of the three conversion functions writes a seat', () => {
  it('writes no seat in any spelling, in any of the three, over comment-stripped code', () => {
    // THE DESIGN IN ONE ASSERTION. Every value the specification forbids the
    // conversion to change - stack, baseline, stay clock, rejoin obligation,
    // rake history, player identity, cluster membership, cluster_join_at -
    // lives on a row nothing here writes. There is no UPDATE of
    // table_seats.stack to get wrong.
    for (const f of CONVERSION) {
      expect(f.biz, `${f.name} writes table_seats`).not.toMatch(SEAT_WRITE);
      expect(f.biz, `${f.name} truncates table_seats`).not.toMatch(/\bTRUNCATE\b/i);
    }
    // NON-VACUITY: the commit READS seats, at length - the orphan check, the
    // chip snapshot taken twice, the eligible set and the census. So the
    // absence above is an absence of WRITES and not an absence of the table.
    expect(count(COMMIT_ON.body, /FROM public\.table_seats\b/g)).toBeGreaterThanOrEqual(4);
    expect(COMMIT_ON.body).toContain('SELECT coalesce(sum(ts.stack), 0) INTO v_before');
    expect(COMMIT_ON.body).toContain('SELECT coalesce(sum(ts.stack), 0) INTO v_after');
    expect(COMMIT_ON.body).toContain('IF v_after IS DISTINCT FROM v_before THEN');
    expect(COMMIT_ON.body).toMatch(/RAISE EXCEPTION 'LIGHTNING_CONVERSION_MOVED_MONEY/);
    // The only row a conversion creates for a player points at the cash session
    // they already had: "Entering/exiting Lightning does not create a new cash
    // session." A new one here would be the money move F12 forbids, spelled
    // differently.
    expect(COMMIT_ON.body).toContain('INSERT INTO public.lightning_pool_session');
    expect(COMMIT_ON.body, 'the conversion opens a new cash session').not.toMatch(
      /INSERT\s+INTO\s+public\.cash_player_session\b/i
    );
    // THE SESSION IS FOUND BY ANY OF THE THREE ROUTES A SEAT HAS TO ONE, not
    // by cluster_id alone: cash_player_session.cluster_id is a nullable added
    // column, so a session opened against a table scope carries NULL there and
    // a lookup that asked only for cluster_id would have found nothing and
    // refused the whole Cluster's conversion.
    expect(COMMIT_ON.body).toMatch(
      /SELECT s\.id FROM public\.cash_player_session s\s+WHERE s\.player_id = ts\.user_id AND s\.closed_at IS NULL\s+AND \(s\.cluster_id = g\.id\s+OR s\.scope_id IN \(SELECT id FROM public\.tables WHERE cluster_id = g\.id\)\s+OR s\.table_id IN \(SELECT id FROM public\.tables WHERE cluster_id = g\.id\)\)/
    );
  });

  it('halts dealing without closing, unseating or reaping anything', () => {
    // The halt means one thing: finish the hand you are in and start no other.
    // A conversion that closed the table, dropped the engine or unseated a
    // player would be the economic operation the specification says this is
    // not. Both columns move together, always - the CHECK below requires it.
    expect(BEGIN_ON.body).toMatch(
      /UPDATE public\.tables\s+SET dealing_halted_at = clock_timestamp\(\), dealing_halted_reason = 'lightning_pending_on'/
    );
    expect(COMMIT_ON.body).toMatch(/dealing_halted_reason = 'lightning'/);
    expect(ABORT.body).toMatch(/SET dealing_halted_at = NULL, dealing_halted_reason = NULL/);
    for (const f of CONVERSION) {
      expect(f.biz, `${f.name} deletes a row`).not.toMatch(/\bDELETE\s+FROM\b/i);
      // Read per UPDATE statement rather than over the whole body, because two
      // of these three legitimately set a `status` - on the conversion RECORD.
      // A rule spelled `SET ... status =` over the body would match that and go
      // red on correct code, which is the same shape as the defect this file's
      // blanking exists for.
      const tableWrites = [...f.biz.matchAll(/UPDATE public\.tables[\s\S]*?;/g)].map((m) => m[0]);
      for (const u of tableWrites) {
        expect(u, `${f.name} closes a table`).not.toMatch(/\blifecycle\s*=/);
        expect(u, `${f.name} deletes a table`).not.toMatch(/\bis_deleted\s*=/);
        expect(u, `${f.name} changes a table status`).not.toMatch(/\bstatus\s*=/);
        expect(u, `${f.name} reaps a table`).not.toMatch(/\bclosed_at\s*=/);
      }
      expect(tableWrites.length, `${f.name} stopped writing the halt at all`).toBe(1);
    }
    // The abort lifts ONLY the halt this conversion placed. Clearing every halt
    // would be a Lightning conversion silently restarting a table somebody else
    // deliberately stopped.
    expect(ABORT.body).toContain(
      "WHERE cluster_id = g.id AND dealing_halted_reason = 'lightning_pending_on';"
    );
  });

  it('closes the one hole the engine cannot, by cancelling pending seat moves', () => {
    // The engine's start-up wait loop never re-reads its table row, so it can
    // see neither the halt being set nor it being lifted, and it still runs
    // executeIdleSeatMoves(). A move planned a second before PENDING_ON would
    // execute mid-conversion and write table_seats from the engine instead. The
    // database owns that hole rather than the engine papering over it.
    expect(BEGIN_ON.body).toMatch(/UPDATE public\.cash_seat_moves\s+SET state = 'cancelled'/);
    expect(BEGIN_ON.body).toContain("WHERE game_id = g.id AND state = 'pending';");
    // 'cancelled' already exists in cash_seat_moves_state_check and the REASON
    // vocabulary is untouched, because its four values are pinned twice in
    // server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts and a fifth
    // would break two assertions for no gain.
    expect(CODE, 'the reason vocabulary was widened').not.toMatch(
      /cash_seat_moves_reason_check|ALTER TABLE public\.cash_seat_moves/
    );
  });
});

// ===========================================================================
//  3b. MEMBERSHIP IS ONE PREDICATE, AND IT DOES NOT MENTION status
// ===========================================================================

/**
 * Section 5c's substitution block QUOTES the old, uncoalesced predicate as a
 * string literal - it has to, because that string is the anchor it substitutes
 * away - so a rule spelled as an absence over the whole file would be false on
 * correct code. Every absence below is therefore taken either over BIZ, where
 * literals are blanked, or over the file with that one block removed, and each
 * is stated together with the non-vacuity that proves the blanking is what
 * makes it expressible at all.
 */
const POP = doBlock('pop');
const MEMBERSHIP_SCOPE = POP ? CODE.split(POP).join('\n') : CODE;

/**
 * The one membership predicate, in the only two spellings it is allowed to
 * have: qualified where a join names the table `tb`, and bare inside
 * `UPDATE public.tables`, where there is no alias to qualify with. Anything
 * else is a third spelling, and a third spelling is how two readers of one
 * population start disagreeing.
 */
const MEMBER_QUALIFIED =
  "coalesce(tb.is_deleted, false) = false AND coalesce(tb.lifecycle, '') <> 'closed'";
const MEMBER_BARE = "coalesce(is_deleted, false) = false AND coalesce(lifecycle, '') <> 'closed'";

/** The statement a character offset falls inside, semicolon to semicolon. */
const stmtAround = (hay: string, at: number): string => {
  const a = hay.lastIndexOf(';', at);
  const b = hay.indexOf(';', at);
  return hay.slice(a + 1, b < 0 ? hay.length : b + 1);
};

describe('Phase 5: membership is one predicate, coalesced, and status decides nothing', () => {
  it('never decides who is in a Cluster by the nullable status column', () => {
    // THE DEFECT, IN ONE SENTENCE: `tables.status` IS NULLABLE, ITS CHECK DOES
    // NOT STOP THAT BECAUSE A CHECK THAT EVALUATES TO NULL PASSES, AND
    // `NULL IN (...)` IS NULL RATHER THAN TRUE.
    //
    // An earlier cut of this file required `status IN ('waiting', 'running',
    // 'active')` beside the lifecycle test. A NULL-status board was therefore
    // dropped from the halt AND from every player-set query at once - and that
    // is the worst possible combination, because both sides narrowed together
    // and the `v_pool <> v_seated` guard still agreed. Reproduced on a
    // throwaway backend: a Cluster of 21 converted, 18 entered the pool, and 3
    // players kept being dealt cash at a board nobody stopped, inside a Cluster
    // that had become Lightning, holding no pool session, with the tick and the
    // balancer stood down so that nothing would ever come for them.
    //
    // Taken over BIZ, because section 5c has to quote the old form to remove
    // it. Both directions, as this file does everywhere.
    expect(CODE, 'the substitution block no longer quotes the form it removes').toMatch(
      /tb\.status IN \(''waiting''/
    );
    expect(BIZ, 'a query decides Cluster membership by tables.status').not.toMatch(
      /\btb\.status\b/
    );
    expect(BIZ, 'a query decides Cluster membership by tables.status').not.toMatch(/\bt\.status\b/);
    expect(
      MEMBERSHIP_SCOPE,
      'the engine-facing status vocabulary is back in a membership filter'
    ).not.toMatch(/status\s+IN\s*\(\s*'waiting'/);
    // AND THE RULE IS NOT A BLANKET BAN ON THE WORDS `status IN`, which would
    // be a rule about spelling rather than about membership: the conversion
    // RECORD has a status and it is quite right to close its vocabulary.
    expect(CODE, 'the conversion record lost its own status vocabulary').toContain(
      "CHECK (status IN ('pending', 'committed', 'aborted'))"
    );
    // The live catalogue is asked the same question about both re-cut readers
    // after the file applies, which is the half no source test can do.
    expect(PROOFS.join('\n')).toContain(
      "fn_cash_cluster_live_eligible(uuid,timestamp with time zone,integer)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') !~ 'status IN'"
    );
    expect(PROOFS.join('\n')).toContain("!~ 'tb\\.status IN'");
  });

  it('spells the one predicate identically at every membership site, counted', () => {
    // DRIVEN OFF A REGEX, NOT OFF A LIST OF PLACES SOMEBODY REMEMBERED. Every
    // mention of either column anywhere in this file's own queries has to BE
    // the predicate - so a site added later cannot arrive with a different
    // spelling, and cannot arrive with only half of it.
    const deleted = [
      ...MEMBERSHIP_SCOPE.matchAll(/coalesce\((?:tb\.)?is_deleted, false\) = false/g),
    ];
    const lifecycle = [
      ...MEMBERSHIP_SCOPE.matchAll(/coalesce\((?:tb\.)?lifecycle, ''\) <> 'closed'/g),
    ];
    expect(
      deleted.length,
      'this file has stopped asking which tables belong to a Cluster'
    ).toBeGreaterThanOrEqual(7);
    // EVERY mention, not merely the coalesced ones: an uncoalesced `tb.lifecycle
    // <> 'closed'` added tomorrow would not be counted by the regexes above and
    // would slip past a floor, so the two totals are compared instead.
    expect(
      count(MEMBERSHIP_SCOPE, /\bis_deleted\b/g),
      'an is_deleted test that is not the coalesced membership predicate'
    ).toBe(deleted.length);
    expect(
      count(MEMBERSHIP_SCOPE, /\blifecycle\b/g),
      'a lifecycle test that is not the coalesced membership predicate'
    ).toBe(lifecycle.length);
    expect(deleted.length, 'the two halves are no longer stated together').toBe(lifecycle.length);
    // AND THE TWO HALVES ARE ADJACENT, IN ONE OF EXACTLY TWO SPELLINGS, in the
    // same statement, with no status anywhere near them.
    const flatScope = flat(MEMBERSHIP_SCOPE);
    expect(
      count(flatScope, new RegExp(MEMBER_QUALIFIED.replace(/[(){}.*+?[\]^$|\\]/g, '\\$&'), 'g')) +
        count(flatScope, new RegExp(MEMBER_BARE.replace(/[(){}.*+?[\]^$|\\]/g, '\\$&'), 'g')),
      'a membership site spells the predicate some third way'
    ).toBe(deleted.length);
    for (const m of deleted) {
      const stmt = flat(stmtAround(MEMBERSHIP_SCOPE, m.index ?? 0));
      expect(
        stmt.includes(MEMBER_QUALIFIED) || stmt.includes(MEMBER_BARE),
        `a membership site that does not carry both halves together: ${stmt.slice(0, 160)}`
      ).toBe(true);
      expect(stmt, `a membership site still filters on status: ${stmt.slice(0, 160)}`).not.toMatch(
        /\bstatus\b/
      );
    }
  });

  it('puts the authorising number on the same predicate as the queries it authorises', () => {
    // fn_cash_cluster_live_eligible IS THE NUMBER THAT SAYS YES. Leaving it
    // uncoalesced would not have stranded anybody - Phase 5's own queries are
    // coalesced and the stranding assertion asks from the halted side - but it
    // would have made the authorising number and the audit record wrong in two
    // ways that matter: a Cluster whose players sit on such a board is told
    // threshold_not_reached and NEVER converts, and when it does convert
    // trigger_population is written short, which is the number an operator
    // reads afterwards to understand what happened.
    expect(
      flat(LIVE_ELIGIBLE.body),
      'the authorising number lost the membership predicate'
    ).toContain(MEMBER_QUALIFIED);
    expect(LIVE_ELIGIBLE.body, 'the authorising number is back on a nullable column').not.toMatch(
      /\bstatus\b/
    );
    // Its two deduplicating guards are unchanged by the re-cut. UNION
    // deduplicates the rows and count(DISTINCT) deduplicates the count, and a
    // player seated with chips whose pool session already exists is in BOTH
    // halves during exactly the window a conversion opens.
    expect(LIVE_ELIGIBLE.body).toMatch(/\bUNION\b/);
    expect(LIVE_ELIGIBLE.body, 'UNION ALL double-counts the conversion window').not.toMatch(
      /\bUNION ALL\b/
    );
    expect(LIVE_ELIGIBLE.body).toContain('count(DISTINCT u.player_id)');
    // Law 10.5 again: a horse counts exactly like a human.
    expect(LIVE_ELIGIBLE.body, 'the authorising number discriminates against a horse').not.toMatch(
      /is_horse/
    );
  });
});

// ===========================================================================
//  4. THE FREEZE IS HONOURED ON THE WAY IN AND NOT ON THE WAY OUT
// ===========================================================================

describe('Phase 5: the freeze gates entering Lightning and never gates leaving it', () => {
  it('gates begin_pending_on and commit_lightning, and deliberately does not gate the abort', () => {
    // A conversion moves no chips, but it stops every table in a Cluster from
    // dealing, which is emphatically an engine-affecting act, and the break
    // exists so that the engine is doing one thing at a time. The ABORT is the
    // mirror image: a Cluster stuck in PENDING_ON with every table halted is
    // exactly the state an operator has to be able to leave during an incident,
    // and the break is when incidents are handled. Both halves are pinned,
    // because gating all three looks tidier and would make a half-converted
    // Cluster unrecoverable for the length of the window.
    expect(BEGIN_ON.body).toContain('IF public.fn_platform_frozen() THEN');
    expect(BEGIN_ON.body).toContain("'reason', 'platform_frozen'");
    expect(COMMIT_ON.body).toContain('IF public.fn_platform_frozen() THEN');
    expect(COMMIT_ON.body).toContain("'reason', 'platform_frozen'");
    // AND HERE IS THE COMMENT STRIP EARNING ITS KEEP AGAIN. The abort's body
    // NAMES fn_platform_frozen, in the comment that explains why it is not
    // gated on it - so this same absence run against the raw body is FALSE.
    // Stated in both directions: if that comment ever goes, the first line goes
    // red rather than the absence quietly becoming easy.
    expect(ABORT.raw, 'the abort no longer explains why it is ungated').toMatch(
      /fn_platform_frozen/
    );
    expect(
      ABORT.body,
      'the abort is gated on the freeze and a half-converted Cluster is stuck'
    ).not.toMatch(/fn_platform_frozen/);
    // And the migration asserts the same asymmetry against the live catalogue
    // after it applies, which is the half no source test can do.
    expect(SQL).toMatch(
      /RAISE EXCEPTION 'the abort is gated on the freeze, so a half-converted Cluster could not be recovered during an incident'/
    );
  });

  it('asks idempotency BEFORE the freeze, so a retry is answered during a break', () => {
    // ORDERING, AND IT IS NOT COSMETIC. A worker retrying a request that
    // already succeeded must be told so even during a break; answering
    // 'platform_frozen' to a retry makes it keep retrying for the length of the
    // window, which is the opposite of what the freeze is for.
    const priorAt = BEGIN_ON.body.indexOf('conversion_request_id = p_request_id');
    const frozenAt = BEGIN_ON.body.indexOf('fn_platform_frozen');
    const lockAt = BEGIN_ON.body.indexOf('FOR UPDATE');
    expect(priorAt).toBeGreaterThan(-1);
    expect(frozenAt, 'the freeze is asked before the idempotency read').toBeGreaterThan(priorAt);
    expect(lockAt, 'the Cluster is locked before the freeze is even asked').toBeGreaterThan(
      frozenAt
    );
    // AND cluster_id = p_game_id IS NOT DECORATION. Without it a request id
    // belonging to Cluster A, replayed against Cluster B, answered {"ok": true}
    // about A while B was never touched and stayed must_move.
    expect(BEGIN_ON.body).toContain(
      'WHERE conversion_request_id = p_request_id AND cluster_id = p_game_id;'
    );
    expect(BEGIN_ON.body).toContain("'reason', 'request_id_belongs_to_another_cluster'");
  });

  it('takes the Cluster lock first, in the tick own lock order', () => {
    // fn_cash_cluster_tick's second statement is SELECT * FROM cash_games WHERE
    // id = ... FOR UPDATE before it touches anything else. Taking the same lock
    // first here means the two can only ever BLOCK, never cycle. A previous
    // Lightning migration deadlocked in production by taking cash_games from a
    // backfill while the tick held cash_cluster_events and wanted cash_games.
    for (const f of CONVERSION) {
      expect(f.body, `${f.name} does not lock its Cluster at all`).toContain(
        'SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;'
      );
      const lockAt = f.body.indexOf('FOR UPDATE');
      const eventAt = f.body.indexOf('cash_cluster_events');
      if (eventAt > -1) {
        expect(
          eventAt,
          `${f.name} touches cash_cluster_events before it holds the Cluster lock`
        ).toBeGreaterThan(lockAt);
      }
    }
  });
});

// ===========================================================================
//  5. PENDING_ON DECIDES AND CONVERTS NOTHING
// ===========================================================================

describe('Phase 5: begin_pending_on moves no epoch and creates no pool session', () => {
  it('sets the state and nothing else on cash_games', () => {
    // THE ORDERING PROPERTY THAT MAKES AN ABORT CHEAP. The specification creates
    // the next Epoch at step 13, AFTER the re-check at steps 10-11, not at step
    // 5. Because no epoch has moved and no session exists when PENDING_ON is
    // entered, an abort is a two-column clear rather than an unwind: nothing
    // that binds to an epoch - a pool session, an instance, a hand - can have
    // been created against an epoch that then has to be rolled back. This is
    // the whole reason test F04 ("18th player leaves during PENDING_ON") is a
    // state change and not a reconciliation.
    expect(BEGIN_ON.body).toContain(
      "UPDATE public.cash_games SET cluster_mode = 'pending_on', updated_at = now()"
    );
    expect(count(BEGIN_ON.body, /UPDATE public\.cash_games/g)).toBe(1);
    expect(BEGIN_ON.body, 'PENDING_ON bumps the epoch').not.toMatch(/cluster_epoch\s*\+/);
    expect(BEGIN_ON.body, 'PENDING_ON writes the epoch').not.toMatch(/SET[^;]*cluster_epoch/);
    expect(BEGIN_ON.body, 'PENDING_ON creates a pool session').not.toMatch(
      /lightning_pool_session/
    );
    expect(BEGIN_ON.body, 'PENDING_ON stamps an epoch reason it has no epoch for').not.toMatch(
      /ca\.epoch_reason/
    );
    // It reads the epoch, and only to write it down as epoch_before.
    expect(BEGIN_ON.body).toMatch(/epoch_before\)/);
    expect(BEGIN_ON.body).toMatch(/g\.cluster_epoch\)/);
    // NON-VACUITY: the commit does both of the things the begin must not, so
    // the four absences above are about ordering and not about a migration that
    // never bumps an epoch or creates a session anywhere.
    expect(COMMIT_ON.body).toContain('v_epoch := g.cluster_epoch + 1;');
    expect(COMMIT_ON.body).toContain('INSERT INTO public.lightning_pool_session');
    // And the migration says the same thing in its installed COMMENT, so an
    // operator reading the catalogue is told the ordering too.
    expect(SQL).toMatch(/It converts nothing: no epoch moves and no pool session is created/);
  });

  it('verifies MUST_MOVE, asks the verdict, and stops below the ON threshold', () => {
    // Steps 2, 3 and 4. A Cluster already in pending_on is not an error to the
    // caller - it is the answer to "is a conversion in progress" - so it is
    // reported rather than raised.
    expect(BEGIN_ON.body).toContain("IF g.cluster_mode <> 'must_move' THEN");
    expect(BEGIN_ON.body).toContain("'reason', 'wrong_state'");
    expect(BEGIN_ON.body).toContain('v_state := public.fn_cash_cluster_lightning_state(g.id);');
    // coalesce, NOT a bare cast. fn_cash_cluster_lightning_state returns jsonb,
    // and a missing or JSON-null key casts to SQL NULL - and `IF NOT NULL` is
    // NULL, which plpgsql takes as false, so the bare form would have read a
    // verdict it could not parse as "convert". Below the threshold and cannot
    // tell are the same answer here, and both must be NO.
    expect(BEGIN_ON.body).toContain(
      "IF NOT coalesce((v_state -> 'verdict' ->> 'would_turn_on')::boolean, false) THEN"
    );
    expect(BEGIN_ON.body).toContain("'reason', 'threshold_not_reached'");
    expect(BEGIN_ON.body, 'the begin raises instead of answering').not.toMatch(/\bRAISE\b/);
    // The nine mandated fields are all written down, from the verdict the lobby
    // already embeds, so the number that triggers a conversion is the number a
    // player was shown.
    for (const col of [
      'cluster_id',
      'conversion_request_id',
      'from_mode',
      'to_mode',
      'trigger_population',
      'on_threshold',
      'off_threshold',
      'epoch_before',
    ]) {
      expect(BEGIN_ON.body, `the conversion record loses ${col}`).toContain(col);
    }
  });
});

// ===========================================================================
//  6. THE COMMIT RE-ASKS, WAITS FOR A BOUNDARY, AND BUMPS BY ONE
// ===========================================================================

describe('Phase 5: the commit re-asks the population it was told about at PENDING_ON', () => {
  it('re-reads the verdict rather than trusting the decision made at step 5', () => {
    // STEPS 10 AND 11 ARE THE WHOLE REASON THE PREVIOUS MIGRATION EXISTED. The
    // population is asked AGAIN here, in pending_on, and the verdict has to be
    // able to answer in that state - until 20260921142954 it required
    // cluster_mode = 'must_move', so this re-check would have returned false
    // unconditionally and every conversion would have aborted at its own safety
    // check. Trusting the trigger_population written at PENDING_ON instead
    // would convert a Cluster on a number that may be minutes old and a player
    // short, which is F15.
    expect(COMMIT_ON.body).toContain('v_state := public.fn_cash_cluster_lightning_state(g.id);');
    expect(COMMIT_ON.body).toContain(
      "IF NOT coalesce((v_state -> 'verdict' ->> 'would_turn_on')::boolean, false) THEN"
    );
    expect(COMMIT_ON.body, 'the commit converts on the stored number').not.toMatch(
      /v_conv\.trigger_population/
    );
    // Below the threshold it aborts ITSELF, through the same step-11 path F04
    // uses, rather than inventing a second way back to must_move.
    expect(COMMIT_ON.body).toContain('RETURN public.fn_cash_cluster_abort_pending_on(');
    expect(COMMIT_ON.body).toContain("'population_fell_below_on_threshold_at_boundary'");
    // 'converted' exists because 'ok' cannot carry this: a successful abort IS
    // ok, and a caller branching on ok alone would read a self-abort as a
    // conversion.
    expect(COMMIT_ON.body).toContain("|| jsonb_build_object('converted', false)");
    expect(count(COMMIT_ON.body, /'converted', false/g)).toBeGreaterThanOrEqual(5);
  });

  it('tests the conversion-safe hand boundary on ended_at, bounded so it can arrive', () => {
    // The phrase "conversion-safe boundary" appears once in the specification
    // and is never defined there, so it is defined here: no table of this
    // Cluster has a hand in flight. An abandoned hand_history row from a
    // crashed engine has ended_at NULL for ever, and a boundary test that
    // waited for it would wait for ever and no Cluster would convert again -
    // hence the window. The halt placed at step 6 is what makes the boundary
    // ARRIVE rather than merely be tested for.
    expect(COMMIT_ON.body).toContain('FROM public.hand_history h');
    expect(COMMIT_ON.body).toContain('h.ended_at IS NULL');
    expect(COMMIT_ON.body).toMatch(/h\.started_at > clock_timestamp\(\) - interval '6 hours'/);
    expect(COMMIT_ON.body).toContain("'reason', 'hands_in_flight'");
    // It polls rather than blocks: blocking would hold the Cluster lock while
    // tables finish their hands and the tick would queue behind it for the
    // length of a river.
    expect(COMMIT_ON.body, 'the commit sleeps while holding the Cluster lock').not.toMatch(
      /pg_sleep|LOOP\b/i
    );
  });

  it('bumps the epoch by exactly one and says why', () => {
    // ca.epoch_reason is read by fn_cash_cluster_epoch_follows_its_game for
    // cash_cluster_epoch.started_by; without it the row records 'unstated', and
    // an epoch nobody can explain is an epoch nobody can audit. The +1 is
    // pinned as an exact string and then as a count, because +2 and + v_n are
    // one-character edits that compile.
    expect(COMMIT_ON.body).toContain(
      "PERFORM set_config('ca.epoch_reason', 'lightning_on', true);"
    );
    expect(COMMIT_ON.body).toContain('v_epoch := g.cluster_epoch + 1;');
    // Every advance of the epoch in this body, and what it advances BY, read
    // out of the text rather than asserted as an absence - `+ 2` and `+ v_n`
    // are one-character edits that compile, and an absence written as a
    // negative lookahead is satisfied by the whitespace in front of the digit.
    const bumps = [...COMMIT_ON.body.matchAll(/cluster_epoch\s*\+\s*([^\s;]+)/g)].map((m) => m[1]);
    expect(bumps, 'the epoch no longer moves by exactly one, exactly once').toEqual(['1']);
    expect(COMMIT_ON.body).toContain(
      "SET cluster_mode = 'lightning', cluster_epoch = v_epoch, updated_at = now()"
    );
    // The record says the same thing, and a CHECK refuses a committed row whose
    // epoch did not move forward.
    expect(COMMIT_ON.body).toContain(
      "SET status = 'committed', epoch_after = v_epoch, closed_at = clock_timestamp()"
    );
    expect(CODE).toContain('CHECK (epoch_after IS NULL OR epoch_after > epoch_before)');
  });

  it('checks for orphaned eligible players BEFORE the epoch bump, not after', () => {
    // THIS ORDERING IS A DEFECT THAT WAS REALLY IN AN EARLIER CUT, AND IT IS
    // WORTH SPELLING OUT WHY IT MATTERS.
    //
    // The orphan check refuses the conversion when a seated eligible player has
    // no open Cluster cash session, and it refuses it by calling
    // fn_cash_cluster_abort_pending_on - the same step-11 path F04 uses. That
    // function begins by testing `g.cluster_mode <> 'pending_on'` and answering
    // 'wrong_state'.
    //
    // So if the orphan check runs AFTER the epoch bump, the Cluster is already
    // cluster_mode = 'lightning' by the time the self-abort is attempted. The
    // abort is refused with wrong_state, the commit returns that refusal, and
    // the transaction COMMITS anyway - leaving a Cluster in 'lightning', at an
    // epoch that moved, with NO pool sessions created, because the function
    // returned before the INSERT. Every player in it is seated at a table that
    // has stopped dealing, in a Cluster that believes it is a pool, which is
    // precisely the stranding the specification forbids.
    //
    // Asserted by character index, because no catalogue read-back can see the
    // order of two statements inside one function body.
    const orphanAt = COMMIT_ON.body.indexOf('INTO v_orphan');
    const orphanGuardAt = COMMIT_ON.body.indexOf('IF v_orphan > 0 THEN');
    const reasonAt = COMMIT_ON.body.indexOf("set_config('ca.epoch_reason'");
    const bumpAt = COMMIT_ON.body.indexOf('v_epoch := g.cluster_epoch + 1;');
    const modeAt = COMMIT_ON.body.indexOf("cluster_mode = 'lightning'");
    const poolAt = COMMIT_ON.body.indexOf('INSERT INTO public.lightning_pool_session');

    expect(orphanAt, 'the orphan check is gone').toBeGreaterThan(-1);
    expect(orphanGuardAt, 'the orphan count is taken and never tested').toBeGreaterThan(orphanAt);
    expect(bumpAt, 'the epoch is bumped before the orphan check').toBeGreaterThan(orphanGuardAt);
    expect(reasonAt, 'the epoch reason is stamped before the orphan check').toBeGreaterThan(
      orphanGuardAt
    );
    expect(modeAt, 'the Cluster is made lightning before the orphan check').toBeGreaterThan(
      orphanGuardAt
    );
    expect(poolAt, 'the pool sessions are created before the epoch exists').toBeGreaterThan(bumpAt);
    // The self-abort really is the refusal path, and the abort really does
    // refuse a Cluster that is no longer pending_on - which is what makes the
    // ordering load-bearing rather than stylistic.
    expect(
      COMMIT_ON.body.slice(orphanGuardAt, bumpAt),
      'the orphan refusal no longer goes through the abort'
    ).toContain('public.fn_cash_cluster_abort_pending_on(');
    expect(ABORT.body).toContain("IF g.cluster_mode <> 'pending_on' THEN");
    expect(ABORT.body).toContain("'reason', 'wrong_state'");
    // Both boundary tests are ahead of the bump too, for the same reason.
    expect(bumpAt).toBeGreaterThan(COMMIT_ON.body.indexOf('INTO v_inflight'));
    expect(bumpAt).toBeGreaterThan(COMMIT_ON.body.indexOf('would_turn_on'));
  });

  it('counts the set that entered the pool against the set that was counted', () => {
    // The F15 half a threshold cannot see: a Fast Fold storm at the boundary
    // changes WHO is eligible, and the set that entered the pool must be the
    // set that was counted. A count of eighteen is satisfied by seventeen right
    // players and one wrong one, so the eligibility predicate is restated
    // identically on both sides and the two are compared.
    expect(COMMIT_ON.body).toContain('IF v_pool <> v_seated THEN');
    expect(COMMIT_ON.body).toMatch(/RAISE EXCEPTION 'LIGHTNING_CONVERSION_LEFT_SOMEBODY_BEHIND/);
    for (const pred of [
      'ts.left_at IS NULL',
      'ts.user_id IS NOT NULL',
      'coalesce(ts.is_sitting_out, false) = false',
      'coalesce(ts.leave_pending, false) = false',
      'coalesce(ts.stack, 0) > 0',
    ]) {
      expect(
        count(COMMIT_ON.body, new RegExp(pred.replace(/[(){}.*+?[\]^$|\\]/g, '\\$&'), 'g')),
        `the eligibility predicate ${pred} is not stated on all three of the orphan check, the pool insert and the census`
      ).toBeGreaterThanOrEqual(3);
    }
    // LAW 10.5: A HORSE COUNTS EXACTLY LIKE A HUMAN. Not one of the three
    // functions may discriminate, and the predicate above is exactly where a
    // well-meaning `AND NOT ts.is_horse` would go. Taken on the stripped body,
    // because the commit's own comment says "NO is_horse ANYWHERE" and cites
    // the law test - so this absence run against the raw body is FALSE, which
    // is the third time in this file the strip is what makes a true rule
    // expressible. Both directions again.
    expect(COMMIT_ON.raw, 'the commit no longer explains why a horse is not singled out').toMatch(
      /is_horse/
    );
    for (const f of CONVERSION) {
      expect(f.body, `${f.name} discriminates against a horse`).not.toMatch(/is_horse/);
    }
  });

  it('finds the session by every route a seat has to one, and breaks the tie on purpose', () => {
    // A BARE `<boolean> DESC` IMPLIES NULLS FIRST, AND THAT IS THE WHOLE BUG.
    // cash_player_session.cluster_id is a nullable added column, so for a
    // session matched only by its table scope the sort key is NULL - and
    // `ORDER BY (s.cluster_id = g.id) DESC` therefore put exactly the session
    // the key exists to DEPRIORITISE at the top. A player holding both an open
    // cluster-scoped session and an open table-scoped one - a shape
    // cash_player_session_one_open explicitly permits - got the wrong parent on
    // their pool session, silently, and the pool session is what the matcher
    // bills against.
    expect(COMMIT_ON.body).toContain(
      'ORDER BY coalesce(s.cluster_id = g.id, false) DESC, s.opened_at DESC, s.id LIMIT 1'
    );
    expect(COMMIT_ON.body, 'the tie-break is back on a bare nullable boolean').not.toMatch(
      /ORDER BY\s+\(?\s*s\.cluster_id = g\.id\s*\)?\s+DESC/
    );
    // The tie-break is total: opened_at can tie and s.id cannot, so the row
    // chosen does not depend on a scan order nobody controls.
    expect(COMMIT_ON.body, 'the tie-break can still tie').toMatch(/DESC, s\.id LIMIT 1/);
    // DISTINCT ON and the ORDER BY that feeds it agree, so one pool session per
    // PLAYER is a property of the statement rather than of the data.
    expect(COMMIT_ON.body).toContain('SELECT DISTINCT ON (ts.user_id)');
    expect(COMMIT_ON.body).toContain('ORDER BY ts.user_id, ts.joined_at, ts.id;');
  });

  it('asks the orphan question per PLAYER, in the INSERT own words', () => {
    // PER SEAT, NOT PER PLAYER, WAS A REFUSAL OF THE WHOLE CLUSTER. An earlier
    // cut counted seat ROWS with no reachable session. A player seated on two
    // member boards whose only open session was scoped to ONE of them was
    // therefore counted an orphan against the other seat - and the conversion
    // was refused for the entire Cluster, while the INSERT immediately below
    // would happily have found that same player's session. Two queries asking
    // what is meant to be the same question, disagreeing.
    const orphanAt = COMMIT_ON.body.indexOf('INTO v_orphan');
    const orphan = COMMIT_ON.body.slice(orphanAt, COMMIT_ON.body.indexOf('IF v_orphan > 0 THEN'));
    expect(orphan, 'the orphan check is gone').toBeTruthy();
    expect(orphan, 'the orphan check counts seats again, not players').toContain(
      'GROUP BY ts.user_id'
    );
    expect(orphan, 'the orphan check no longer asks per player').toContain('HAVING NOT EXISTS');
    // AND IT IS THE SAME QUESTION, CHARACTER FOR CHARACTER, THAT THE INSERT
    // ASKS. Compared rather than described: a lookup the refusal and the write
    // spell differently is the defect restated, not repaired.
    const SESSION_REACH =
      'AND (s.cluster_id = g.id OR s.scope_id IN (SELECT id FROM public.tables WHERE cluster_id = g.id) ' +
      'OR s.table_id IN (SELECT id FROM public.tables WHERE cluster_id = g.id))';
    expect(
      count(
        flat(COMMIT_ON.body),
        new RegExp(SESSION_REACH.replace(/[(){}.*+?[\]^$|\\]/g, '\\$&'), 'g')
      ),
      'the orphan check and the pool insert no longer reach for a session the same way'
    ).toBe(2);
    expect(flat(orphan)).toContain(SESSION_REACH);
    // The refusal is still a refusal of the CLUSTER and still goes back through
    // the step-11 abort, so a Cluster it cannot convert cleanly is returned to
    // must_move rather than half-converted.
    expect(COMMIT_ON.body).toMatch(/eligible seated player\(s\) have no open cash session/);
  });

  it('counts STRANDED players once each, at the epoch it just created', () => {
    // THE ASSERTION COUNTING CANNOT MAKE. v_pool and v_seated share a
    // predicate, so a predicate that wrongly EXCLUDES a table makes both
    // numbers smaller and they still agree - which is exactly how a nullable
    // column nearly stranded three people. This asks from the OTHER side, over
    // the tables this conversion actually HALTED, and it cannot be satisfied by
    // a filter that narrows: if we stopped a table, every eligible player
    // sitting at it must have somewhere to play.
    const strandedAt = COMMIT_ON.body.indexOf('INTO v_stranded');
    const stranded = COMMIT_ON.body.slice(
      COMMIT_ON.body.lastIndexOf('SELECT', strandedAt),
      COMMIT_ON.body.indexOf('IF v_stranded > 0 THEN')
    );
    expect(stranded, 'the stranding check is gone').toBeTruthy();
    // DISTINCT, because a player seated at two halted boards is one player and
    // an undistinct count would report two and read as two failures.
    expect(stranded, 'the stranding count is no longer per player').toContain(
      'count(DISTINCT ts.user_id)'
    );
    // It asks over the HALTED set, deliberately carrying no membership filter -
    // the whole point is that it cannot be narrowed by the same mistake.
    expect(stranded).toContain('tb.dealing_halted_at IS NOT NULL');
    expect(
      stranded,
      'the stranding check narrowed itself with the predicate it audits'
    ).not.toMatch(/coalesce\(tb\.lifecycle/);
    // AND THE POOL SESSION IT LOOKS FOR IS THE ONE THIS CONVERSION JUST MADE.
    // Without the epoch, a stale session from an earlier epoch of the same
    // Cluster - which Phase 10 and a re-conversion both produce - would answer
    // for a player this conversion never pooled.
    expect(stranded, 'a stale pool session from an earlier epoch would satisfy this').toContain(
      's.cluster_epoch = v_epoch'
    );
    expect(stranded).toContain('s.exited_at IS NULL');
    expect(COMMIT_ON.body).toMatch(/RAISE EXCEPTION 'LIGHTNING_CONVERSION_STRANDED_A_PLAYER/);
  });

  it('coalesces every jsonb the verdict hands it, because a missing key is not a yes', () => {
    // fn_cash_cluster_lightning_state returns jsonb. A key that is absent, or
    // present as JSON null, casts to SQL NULL - and every one of these values
    // is then either a branch or a NOT NULL column. `IF NOT NULL` is NULL,
    // which plpgsql takes as false, so an unparseable verdict would have read
    // as "convert"; and a NULL trigger_population, on_threshold or off_threshold
    // would fail cash_cluster_conversion's NOT NULL at the INSERT and abort the
    // whole transaction with a constraint error instead of an answer.
    //
    // Driven off the text rather than listed: EVERY cast of a v_state lookup
    // must sit inside a coalesce, so a fifth reader added later cannot arrive
    // bare.
    const casts = [...CODE.matchAll(/\(v_state ->[^)]*\)::\w+/g)];
    expect(casts.length, 'nothing reads the verdict any more').toBeGreaterThanOrEqual(9);
    for (const c of casts) {
      const at = c.index ?? 0;
      expect(
        CODE.slice(Math.max(0, at - 9), at),
        `a bare cast of a jsonb the verdict may not carry: ${c[0]}`
      ).toBe('coalesce(');
    }
    // The four readers, each named, so the rule above cannot go vacuous by the
    // verdict simply stopping being read.
    for (const key of [
      'would_turn_on',
      'live_eligible',
      "'thresholds' ->> 'on'",
      "'thresholds' ->> 'off'",
    ]) {
      expect(CODE, `the verdict no longer carries ${key}`).toContain(key);
    }
  });
});

// ===========================================================================
//  7. THE RECORD, AND THE RACE IT GUARDS
// ===========================================================================

describe('Phase 5: the conversion is a row, and the row is the F13 race guard', () => {
  it('carries the nine mandated fields and closes completely or not at all', () => {
    const CREATE = span(CODE, 'CREATE TABLE IF NOT EXISTS public.cash_cluster_conversion', ');');
    expect(CREATE, 'the conversion table is gone').toBeTruthy();
    for (const col of [
      'cluster_id',
      'conversion_request_id',
      'from_mode',
      'to_mode',
      'trigger_population',
      'on_threshold',
      'off_threshold',
      'epoch_before',
      'epoch_after',
      'status',
    ]) {
      expect(CREATE, `the conversion record has no ${col}`).toContain(col);
    }
    // A closed conversion is closed in every column that says so, or the row is
    // lying about its own state; an aborted one must say why, because "aborted"
    // with no reason is the shape that turns a five-minute diagnosis into an
    // afternoon.
    expect(CODE).toContain("CHECK (status IN ('pending', 'committed', 'aborted'))");
    expect(CODE).toContain(
      "(status = 'aborted'   AND closed_at IS NOT NULL AND epoch_after IS NULL AND abort_reason IS NOT NULL)"
    );
    expect(CODE).toContain('CHECK (on_threshold > off_threshold AND off_threshold >= 2)');
  });

  it('answers F13 with a partial unique index and a retry with the request id', () => {
    // Two indexes, two different jobs, and they are easy to confuse.
    // one_open_per_cluster makes a SECOND converter fail rather than open a
    // rival conversion; by_request makes the SAME request idempotent and
    // answerable with what already happened, which is the difference between
    // "no-op safely" and "no-op" - a retrying worker must be TOLD the
    // conversion committed, not told nothing.
    expect(flat(CODE)).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS cash_cluster_conversion_one_open_per_cluster ' +
        "ON public.cash_cluster_conversion (cluster_id) WHERE status = 'pending';"
    );
    expect(flat(CODE)).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS cash_cluster_conversion_by_request ' +
        'ON public.cash_cluster_conversion (conversion_request_id);'
    );
    expect(COMMIT_ON.body).toContain("IF v_conv.status = 'committed' THEN");
    expect(COMMIT_ON.body).toContain("'reason', 'already_committed'");
    expect(COMMIT_ON.body).toContain("'epoch_after', v_conv.epoch_after");
    expect(BEGIN_ON.body).toContain("'reason', 'already_known'");
    // RLS on, browser roles revoked, service_role only.
    expect(CODE).toContain('ALTER TABLE public.cash_cluster_conversion ENABLE ROW LEVEL SECURITY;');
    expect(CODE).toContain(
      'REVOKE ALL ON TABLE public.cash_cluster_conversion FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.cash_cluster_conversion TO service_role;'
    );
  });

  it('refuses a halted table with no reason, which IN alone would accept', () => {
    // `x IN (...)` with x NULL is NULL, not false, AND A CHECK THAT EVALUATES
    // TO NULL PASSES. Without the IS NOT NULL line the constraint accepts the
    // exact row it was written to reject - a halted table with no reason - and
    // because Phase 10's revert matches on the REASON, that table would stay
    // halted for ever. The ordering is asserted, not just the presence: the
    // IS NOT NULL has to be ANDed in ahead of the IN for it to do anything.
    const CHECK = span(CODE, 'ADD CONSTRAINT tables_dealing_halt_is_explained', '$q$;');
    expect(CHECK, 'the halt constraint is gone').toBeTruthy();
    const notNullAt = CHECK.indexOf('dealing_halted_reason IS NOT NULL');
    const inAt = CHECK.indexOf('dealing_halted_reason IN (');
    expect(notNullAt, 'the constraint no longer tests the reason for NULL').toBeGreaterThan(-1);
    expect(inAt, 'the constraint no longer closes the reason vocabulary').toBeGreaterThan(-1);
    expect(notNullAt, 'the NULL test comes after the IN, where it cannot save it').toBeLessThan(
      inAt
    );
    expect(flat(CHECK)).toContain(
      'AND dealing_halted_reason IS NOT NULL AND dealing_halted_reason IN ('
    );
    // Both directions of the pairing, so a reason with no halt is a lie the row
    // cannot tell either.
    expect(flat(CHECK)).toContain('(dealing_halted_at IS NULL AND dealing_halted_reason IS NULL)');
    // The vocabulary is closed on purpose: a typo in a string the revert path
    // matches on would leave a table halted for ever.
    expect(flat(CHECK)).toContain("IN ('lightning_pending_on', 'lightning')");
    expect(count(CHECK, /dealing_halted_reason IN \(/g), 'the vocabulary is spelled twice').toBe(1);
  });
});

// ===========================================================================
//  8. THE TWO ASSERTED SUBSTITUTIONS
// ===========================================================================

const TICK = doBlock('tick');
const BAL = doBlock('bal');

describe('Phase 5: the tick and the balancer are substituted, never retyped', () => {
  it('reads the body from the catalogue and refuses to substitute blind', () => {
    // fn_cash_cluster_tick is 40,443 characters of table lifecycle, must-move
    // planning, feeder windows, opening holds and reconciliation, re-cut by at
    // least eight migrations and pinned by a dozen assertions across
    // TheTablesOpenAndCloseThemselves.law.test.ts. Retyping it to add four lines
    // would be the single most dangerous act in this file. So the body is read
    // from pg_get_functiondef, the anchor is asserted to occur EXACTLY ONCE -
    // not at least once, because a second occurrence means replace() would edit
    // both - and an anchor that has moved raises rather than being patched
    // around.
    for (const [tag, block] of [
      ['tick', TICK],
      ['bal', BAL],
    ] as const) {
      expect(block, `the ${tag} substitution block is gone`).toBeTruthy();
      expect(block, `${tag} retypes a body instead of reading it`).not.toMatch(
        /CREATE OR REPLACE FUNCTION/
      );
      expect(block, `${tag} does not read the body from the catalogue`).toContain(
        'pg_get_functiondef('
      );
      expect(block, `${tag} does not assert its anchor occurs exactly once`).toMatch(/<> 1/);
      expect(block, `${tag} patches around a moved anchor instead of refusing`).toContain(
        'refusing to substitute blind'
      );
      expect(block, `${tag} does not notice a substitution that changed nothing`).toContain(
        'changed nothing'
      );
      expect(count(block, /EXECUTE v_new;/g), `${tag} executes more than once`).toBe(1);
      // Re-appliable: a second apply finds its own marker and stands off rather
      // than substituting into a body that already carries the guard.
      expect(block, `${tag} would substitute twice on a re-apply`).toContain('RAISE NOTICE');
      expect(block).toMatch(/leaving it alone/);
    }
    expect(TICK).toContain("IF v_src ~ 'lightning_cluster_stands_down' THEN");
    expect(BAL).toContain("IF v_src ~ 'cluster_mode' THEN");
  });

  it('reads the result BACK from the catalogue, never from the variable it built', () => {
    // v_new is what the migration INTENDED; only pg_get_functiondef is what the
    // database HAS. A read-back against the variable proves the string was
    // built, which nobody doubted.
    for (const [tag, block] of [
      ['tick', TICK],
      ['bal', BAL],
    ] as const) {
      const execAt = block.indexOf('EXECUTE v_new;');
      const readBackAt = block.indexOf('pg_get_functiondef(', execAt);
      expect(execAt, `${tag} never executes`).toBeGreaterThan(-1);
      expect(
        readBackAt,
        `${tag} does not read the function definition back after executing it`
      ).toBeGreaterThan(execAt);
      const after = block.slice(execAt + 'EXECUTE v_new;'.length);
      expect(after, `${tag} assigns the read-back somewhere other than v_live`).toContain(
        'v_live := pg_get_functiondef('
      );
      expect(after, `${tag} asserts against the variable it built, not the catalogue`).not.toMatch(
        /\bv_new\b/
      );
      // THE BODY GREW. A substitution is additive by definition, so a result no
      // longer than its source means replace() removed as much as it added.
      expect(after, `${tag} does not assert the body grew`).toContain(
        'IF length(v_live) <= length(v_src) THEN'
      );
      expect(after, `${tag} does not say the growth assertion failed`).toMatch(/did not grow/);
      // LAW 10.5 SURVIVES THE EDIT. A horse counts exactly like a human, and a
      // substitution is a way to introduce a discrimination into a body nobody
      // reread.
      expect(after, `${tag} would let is_horse into the body it rewrites`).toMatch(
        /v_live ~ 'is_horse'/
      );
      expect(block, `${tag} inserts is_horse itself`).not.toMatch(/'[^']*is_horse[^']*'\s*\|\|/);
    }
  });

  it('asserts every sibling guard survived the tick edit', () => {
    // These are the guards other law tests pin. A replace() that ate one would
    // be invisible until a Cluster misbehaved, and the guard the stand-down
    // sits directly beneath - the must_move capability test - is the one most
    // at risk, because it is the anchor.
    for (const guard of [
      'IF NOT g\\.must_move THEN RETURN',
      'manual_game',
      'fn_platform_frozen',
      'FOR UPDATE',
    ]) {
      expect(TICK, `the tick substitution stopped checking ${guard} survived`).toContain(guard);
    }
    expect(BAL).toContain("v_live !~ 'fn_cash_cluster_census\\(p_game_id, p_now\\)'");
  });

  it('adds the state guard the capability guard could never be', () => {
    // WHY THE EXISTING GUARD WAS NOT ENOUGH, since it looks like it should have
    // been. `must_move` is a BOOLEAN CAPABILITY - does this game use must-move
    // seating at all - and `cluster_mode` is the STATE. A converting Cluster
    // KEEPS the capability, because Phase 10 reverts to must-move seating using
    // these very rules and a Cluster that turned the capability off on the way
    // in would have nothing to turn back on. The tick read the capability and
    // never the state, so it would have gone on opening feeders, planning
    // moves, balancing and reconciling Main 1 underneath a Lightning pool.
    expect(TICK).toContain("IF g.cluster_mode IS DISTINCT FROM ''must_move'' THEN");
    expect(TICK).toContain("''reason'', ''lightning_cluster_stands_down''");
    expect(TICK, 'the stand-down turns the capability off on the way in').not.toMatch(
      /must_move\s*=\s*(?:false|true)/
    );
    // The guard goes AFTER the must_move test so a manual game still answers
    // 'manual_game', which is pinned elsewhere, and a Lightning Cluster answers
    // for itself.
    const anchorAt = TICK.indexOf("v_anchor constant text := '  IF NOT g.must_move THEN RETURN");
    const insertAt = TICK.indexOf('v_new    text;');
    expect(anchorAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(anchorAt);
    expect(TICK).toContain('v_anchor || chr(10) ||');
    // The balancer stands down for a reason worth stating: tick_all calls it
    // after every tick, in the same transaction, INDEPENDENTLY of what the tick
    // returned, so standing the tick down does not stand it down. Zero moves
    // planned, not an exception - it returns a count and the honest count is
    // zero.
    expect(BAL).toContain(
      "WHERE cg.id = p_game_id AND cg.cluster_mode IS DISTINCT FROM ''must_move'') THEN"
    );
    expect(BAL).toContain("'    RETURN 0;' || chr(10) ||");
    expect(BAL, 'the balancer raises where it should answer zero').not.toMatch(
      /'\s*RAISE EXCEPTION[^']*' \|\| chr\(10\)/
    );
  });

  it('substitutes the breakdown beside it, asserted at five places, read back', () => {
    // WHY fn_cash_cluster_population HAD TO MOVE TOO, AND WHY IT IS THE WORSE
    // HALF OF THE DEFECT. It is the nine-statement breakdown the operator
    // console reads, and it carried the same uncoalesced membership predicate
    // in FIVE places while delegating its headline number to
    // fn_cash_cluster_live_eligible. Fix the delegate alone and the function
    // contradicts itself: on the board this migration's own harness builds it
    // reported live_eligible 24 beside seated_eligible 18, over three live
    // boards and a hundred and twenty seats. An operator reading a console with
    // two numbers on it believes the smaller one.
    expect(POP, 'the breakdown substitution block is gone').toBeTruthy();
    expect(POP, 'the breakdown is retyped instead of read from the catalogue').not.toMatch(
      /CREATE OR REPLACE FUNCTION/
    );
    expect(POP).toContain('pg_get_functiondef(');
    // FIVE, ASSERTED, NOT "at least one". replace() edits every occurrence, so
    // the number of occurrences IS the blast radius: a body carrying four or
    // six is a body this migration has not read, and it refuses rather than
    // substituting blind.
    expect(POP, 'the anchor count is no longer asserted at five').toMatch(/v_n <> 5/);
    expect(POP).toContain('refusing to substitute blind');
    expect(POP).toContain('changed nothing');
    expect(count(POP, /EXECUTE v_new;/g), 'the breakdown is executed more than once').toBe(1);
    // Re-appliable: a second apply finds the coalesced form already there and
    // stands off rather than raising on an anchor count of zero.
    expect(POP).toContain('RAISE NOTICE');
    expect(POP).toMatch(/leaving it alone/);
    // READ BACK FROM THE CATALOGUE, never from the variable it built, and the
    // read-back asserts all three things the substitution could have broken:
    // the old predicate is gone, the new one is in all five places, and the
    // delegation to the one authorising number survived.
    const execAt = POP.indexOf('EXECUTE v_new;');
    const after = POP.slice(execAt + 'EXECUTE v_new;'.length);
    expect(after).toContain('v_live := pg_get_functiondef(');
    expect(after, 'the breakdown asserts against the string it built').not.toMatch(/\bv_new\b/);
    expect(after).toContain("v_live ~ 'tb\\.status IN \\('");
    expect(after).toMatch(/<> 5/);
    expect(after).toContain('fn_cash_cluster_live_eligible');
    expect(after, 'the substitution could introduce is_horse into a body nobody rereads').toMatch(
      /v_live ~ 'is_horse'/
    );
    // AND THE TWO NUMBERS IN ONE ANSWER ARE COMPARED, on every Cluster in the
    // estate, which is the only assertion that can catch a fix applied to one
    // reader and not the other.
    expect(after).toContain("-> 'counted' ->> 'seated_eligible'");
    expect(after).toMatch(/still disagrees with its own headline/);
    // IT IS A REPLACE, NOT A DROP. CREATE OR REPLACE keeps the OID, so the
    // function's grants and its COMMENT survive; a DROP and re-CREATE would
    // silently return it to the PUBLIC EXECUTE default, which is how a reader
    // of a Cluster's population becomes reachable from a browser.
    expect(CODE, 'a re-cut that drops a function loses its grants').not.toMatch(
      /\bDROP\s+FUNCTION\b/i
    );
    expect(POP, 'the breakdown is re-granted, which means it was dropped').not.toMatch(
      /GRANT|REVOKE/
    );
    // NOT additive, unlike the tick and the balancer: this substitution REMOVES
    // a predicate, so the "the body grew" assertion those two carry would be
    // false here and is deliberately absent.
    expect(POP, 'the breakdown claims a growth a removal cannot have').not.toContain(
      'IF length(v_live) <= length(v_src) THEN'
    );
  });

  it('keeps Law 10.5 pinned where the law test can still see it', () => {
    // The migration argues that Law 10.5 - a horse counts exactly like a human -
    // is pinned TWICE against these two bodies. That claim is compared with the
    // law test rather than trusted, so the header cannot rot into a false one.
    const LAW = path.join(
      ROOT,
      'server',
      'src',
      'cluster',
      'TheTablesOpenAndCloseThemselves.law.test.ts'
    );
    expect(fs.existsSync(LAW), 'the law test the migration cites is not in the tree').toBe(true);
    const law = fs.readFileSync(LAW, 'utf8');
    expect(
      count(law, /not\.toMatch\(\/is_horse\//g),
      'Law 10.5 is no longer pinned twice against these bodies'
    ).toBeGreaterThanOrEqual(2);
    expect(SQL).toContain('TheTablesOpenAndCloseThemselves.law.test.ts');
    // And the file asserts it again against the live catalogue after both
    // substitutions, which is the half no source test can do.
    expect(SQL).toMatch(/RAISE EXCEPTION 'LAW 10\.5: a horse counts exactly like a human/);
  });
});

// ===========================================================================
//  9. THE POST-APPLY READ-BACK, AND THE SCAN THAT COULD NOT APPLY AT ALL
// ===========================================================================

describe('Phase 5: it reads itself back from the catalogue, and its scans can run', () => {
  it('carries prokind on every scan that is not restricted to a named allowlist', () => {
    // p.prokind = 'f' IS LOAD-BEARING, NOT TIDINESS. n.nspname is a JOIN qual,
    // so the planner pushes only the p.* quals into the pg_proc scan and
    // evaluates pg_get_functiondef over EVERY catalogue row it touches -
    // including aggregates, for which it raises '"array_agg" is an aggregate
    // function'. Without it the migration cannot apply at all, ANYWHERE: an
    // earlier cut of this file failed on its own read-back on every database it
    // was pointed at. A scan restricted to a fixed `proname IN (...)` allowlist
    // is safe without it and is exempted by name rather than by luck.
    const units = [...PROOFS, doBlock('assert'), doBlock('tick'), doBlock('bal')].filter(Boolean);
    let scans = 0;
    let guarded = 0;
    for (const u of units) {
      if (!u.includes('pg_get_functiondef(p.oid)')) continue;
      scans++;
      const allowlisted = /p?\.?proname\s+IN\s*\(/.test(u);
      if (allowlisted) continue;
      expect(
        u,
        `a catalogue-wide pg_get_functiondef scan with no prokind filter: ${flat(u).slice(0, 160)}`
      ).toMatch(/p\.prokind\s*=\s*'f'/);
      guarded++;
    }
    expect(
      scans,
      'nothing in this file scans the catalogue, so this rule is vacuous'
    ).toBeGreaterThanOrEqual(3);
    expect(
      guarded,
      'no unrestricted catalogue scan exists, so the prokind rule is vacuous'
    ).toBeGreaterThanOrEqual(2);
    // The file explains itself where the next person will look.
    expect(SQL).toMatch(/"array_agg" is an aggregate/);
  });

  it('reads every claim back from the live catalogue rather than from a variable', () => {
    const ASSERT = doBlock('assert');
    expect(ASSERT, 'the post-apply read-back is gone').toBeTruthy();
    for (const fn of [
      'fn_cash_cluster_tick',
      'fn_cash_cluster_balance',
      'fn_cash_cluster_begin_pending_on',
      'fn_cash_cluster_abort_pending_on',
      'fn_cash_cluster_commit_lightning',
    ]) {
      expect(ASSERT, `the read-back does not re-read ${fn}`).toContain(
        `pg_get_functiondef('public.${fn}(`
      );
    }
    // Every text pin in the read-back strips comments first, for the same
    // reason section 2 of this file does: three proofs in this project have
    // already gone false because the body they read quoted, IN A COMMENT, the
    // exact string the proof forbade.
    expect(count(ASSERT, /regexp_replace\(pg_get_functiondef\(/g)).toBeGreaterThanOrEqual(5);
    // AND IT PROVES IT CHANGED NOTHING, MEASURED RATHER THAN ASSUMED. The
    // checksums are taken at the top of the same transaction, before any of
    // this file's own behaviour, and compared - rather than asserting the
    // estate is VIRGIN, which is true today and stops being true the first time
    // Phase 6 drives a conversion.
    const BEFORE = doBlock('before');
    expect(BEFORE, 'the before picture is gone').toBeTruthy();
    for (const key of ['ca.p5_tables', 'ca.p5_games', 'ca.p5_counts']) {
      expect(BEFORE, `${key} is never taken`).toContain(key);
      expect(ASSERT, `${key} is taken and never compared`).toContain(key);
    }
    // set_config(..., true), not a temp table: a CREATE TEMP TABLE is still DDL
    // and still fires this database's break-window event trigger, and an
    // assertion mechanism that can refuse the migration it is asserting about is
    // worse than no assertion.
    expect(BEFORE, 'the before picture is taken in DDL').not.toMatch(/CREATE TEMP TABLE/i);
    expect(count(BEFORE, /set_config\(/g)).toBe(3);
    expect(count(BEFORE, /, true\)/g)).toBe(3);
  });

  it('keeps the capability gate shut, and asserts both halves of it independently', () => {
    // NOTHING CALLS THESE FUNCTIONS, DELIBERATELY. A Cluster converted to
    // LIGHTNING before the Phase 6 matcher exists would strand every one of its
    // eligible players in a pool with no one to deal them a hand. Two
    // independent gates hold until then - lightning_enabled is false on all 166
    // Clusters, and nothing calls these - and both are asserted separately,
    // because the whole safety argument for shipping a conversion before its
    // matcher rests on both.
    const ASSERT = doBlock('assert');
    expect(ASSERT).toContain('FROM public.cash_games WHERE lightning_enabled');
    expect(ASSERT).toMatch(/lightning_enabled and the matcher does not exist yet/);
    expect(ASSERT).toMatch(/already call the conversion, and the matcher does not exist yet/);
    // No trigger, no cron entry, no grant to anything that could reach them
    // from outside a service.
    expect(CODE, 'something now fires the conversion').not.toMatch(
      /CREATE\s+(OR REPLACE\s+)?TRIGGER/i
    );
    expect(CODE, 'the conversion was put on a schedule').not.toMatch(/cron\.schedule/i);
    // A stand-down that stood everything down would pass every other assertion
    // in the read-back, so the tick is asserted to still answer for every live
    // Cluster.
    expect(ASSERT).toMatch(/stopped answering their own state/);
  });
});

// ===========================================================================
//  10. FOUR FUNCTIONS, FOUR PAIRS OF GRANTS, DRIVEN OFF A REGEX
// ===========================================================================

describe('Phase 5: every function it writes is pinned, and service_role only', () => {
  it('makes the three WRITERS definers with a pinned search_path', () => {
    // SECURITY DEFINER deliberately: these write cash_games, tables,
    // cash_seat_moves, cash_cluster_conversion, cash_cluster_events and
    // lightning_pool_session, all of which carry RLS, and an INVOKER function
    // run by a role short of one policy would convert PART of a Cluster rather
    // than refuse. The search_path is pinned because a DEFINER function without
    // one is a privilege escalation waiting for a schema nobody audited.
    for (const f of WRITERS) {
      expect(f.attrs, `${f.name} is not SECURITY DEFINER`).toContain('SECURITY DEFINER');
      expect(f.attrs, `${f.name} does not pin its search_path`).toContain(
        "SET search_path TO 'public', 'pg_temp'"
      );
      expect(f.attrs, `${f.name} is not plpgsql`).toMatch(/\bLANGUAGE plpgsql\b/);
      // A writer marked STABLE or IMMUTABLE can be folded at plan time and run
      // against a snapshot nobody chose. The default VOLATILE is the only
      // correct answer here, and it is asserted as the absence of the other two.
      expect(f.attrs, `${f.name} claims not to write`).not.toMatch(/\b(STABLE|IMMUTABLE)\b/);
    }
  });

  it('leaves the re-cut READER exactly as strong as it was, and no stronger', () => {
    // THE ONE FUNCTION HERE THAT IS NOT A DEFINER, AND MUST NOT BECOME ONE.
    // 20260921064717 created fn_cash_cluster_live_eligible SECURITY INVOKER,
    // LANGUAGE sql, STABLE: it counts and writes nothing, and the lobby reaches
    // it through fn_cash_game_lobby, which IS a definer and embeds it. This
    // migration re-cuts it onto the coalesced membership predicate and changes
    // nothing else, so a rule that demanded SECURITY DEFINER of every function
    // in this file would be demanding a privilege escalation on a counter.
    expect(LIVE_ELIGIBLE.attrs, 'the counter was quietly promoted to a definer').not.toContain(
      'SECURITY DEFINER'
    );
    expect(LIVE_ELIGIBLE.attrs).toMatch(/\bLANGUAGE sql\b/);
    expect(LIVE_ELIGIBLE.attrs, 'a pure counter stopped being STABLE').toContain('STABLE');
    // The search_path is pinned anyway. It is not a privilege boundary for an
    // INVOKER function, and it is still the difference between this counter
    // meaning the same thing to every caller and meaning whatever their session
    // search_path says.
    expect(LIVE_ELIGIBLE.attrs).toContain("SET search_path TO 'public', 'pg_temp'");
    // Non-vacuity, so this whole test cannot pass by the reader disappearing.
    expect(FUNCTIONS.map((f) => f.name)).toContain('fn_cash_cluster_live_eligible');
  });

  it('revokes and grants EVERY function it writes, counted from both ends', () => {
    // DRIVEN OFF THE DISCOVERED SET, NOT A LIST. A fifth function added to this
    // migration later would arrive with no REVOKE and no GRANT and therefore
    // with PUBLIC EXECUTE, which is the default, which is how a SECURITY DEFINER
    // function that halts every table in a Cluster ends up reachable from a
    // browser. Counting from both ends is what closes it: every function has a
    // pair, and there are exactly as many pairs as there are functions, so
    // neither a missing grant nor a stray one naming something this file does
    // not write can pass.
    for (const f of FUNCTIONS) {
      const sig = `public.${f.name}(${f.argTypes})`;
      expect(CODE, `${f.name} is not revoked from the browser roles`).toContain(
        `REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated;`
      );
      expect(CODE, `${f.name} is not granted to service_role`).toContain(
        `GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`
      );
    }
    expect(count(CODE, /^REVOKE ALL ON FUNCTION /gm)).toBe(FUNCTIONS.length);
    expect(count(CODE, /^GRANT EXECUTE ON FUNCTION /gm)).toBe(FUNCTIONS.length);
    // AND NOTHING IS GRANTED TO A BROWSER ROLE. Taken over BIZ, because a
    // COMMENT ON body is prose that happens to sit inside quotes - a fourth
    // proof in this project went false when the words "granted to authenticated"
    // in a COMMENT made a grant-safety regex fire on correct code.
    expect(BIZ, 'something in this file grants a browser role').not.toMatch(
      /GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i
    );
    // Non-vacuity for the rule itself: there ARE grants here, and they all name
    // service_role.
    expect(count(BIZ, /\bGRANT\b/g)).toBeGreaterThanOrEqual(5);
    expect(count(BIZ, /\bTO service_role;/g)).toBe(count(BIZ, /\bGRANT\b/g));
  });

  it('comments the three functions it creates, and does not re-comment the one it re-cuts', () => {
    // A COMMENT PER FUNCTION THIS MIGRATION INVENTS, because the catalogue is
    // where the next operator looks and a function nobody can read is a function
    // somebody guesses at.
    for (const f of WRITERS) {
      expect(SQL, `${f.name} has no COMMENT`).toMatch(
        new RegExp(`COMMENT ON FUNCTION public\\.${f.name}\\([^)]*\\) IS\\s+'`)
      );
    }
    expect(count(SQL, /^COMMENT ON FUNCTION /gm)).toBe(WRITERS.length);
    // AND DELIBERATELY NOT A FOURTH. CREATE OR REPLACE keeps the OID, so
    // fn_cash_cluster_live_eligible still carries the COMMENT 20260921064717
    // installed on it. Restating it here would put two descriptions of one
    // function in two migrations, and the older one is the one that rots
    // unread - which is the same failure this project has already had with
    // duplicated prose in a manifest.
    expect(SQL, 'the re-cut reader now has a second, forkable COMMENT').not.toMatch(
      /COMMENT ON FUNCTION public\.fn_cash_cluster_live_eligible/
    );
    // The section that re-cuts it says so in prose, where the next person looks.
    expect(SQL).toMatch(/Everything else about the function is unchanged/);
  });
});

// ===========================================================================
//  11. THE PROOFS, THE MANIFEST FRAGMENT AND THE CI STEP
// ===========================================================================

describe('Phase 5: it proves what it says, declares what it created, and is wired in', () => {
  it('declares live proofs, every one of them a balanced parenthesised SELECT', () => {
    // The harness wraps each in a SELECT and expects a single true-ish scalar,
    // so a proof that is two statements, or one that does not close its own
    // parenthesis, is not a proof at all - it is a syntax error at verify time.
    // Balanced with the string literals blanked first, because several of these
    // quote regexes containing \( and \), and reading a quoted paren as
    // structure would fail a proof that is perfectly well formed.
    //
    // A FLOOR, NEVER AN EQUALITY, which is the house rule: a count written down
    // in prose is exactly the thing that goes stale. What IS asserted exactly is
    // that the extraction and the raw lines agree, so a proof cannot be silently
    // dropped by the regex that harvests them - the sibling file found that
    // failure mode the hard way, with a brief that said nineteen and a file with
    // eighteen proofs and one prose mention.
    expect(PROOFS.length, 'the extraction lost a proof line').toBe(PROOF_LINES.length);
    // THIRTY, WHICH IS SIX MORE THAN THIS FILE ONCE CARRIED. Six went in with
    // the two re-cut readers: that neither decides membership by status, that
    // the authorising number equals the coalesced count taken independently,
    // that the breakdown never reports more live-eligible players than
    // seated-eligible ones, and that no halted table holds an eligible player
    // with no pool session. A FLOOR, NEVER AN EQUALITY, which is the house
    // rule: a count written down in prose is exactly the thing that goes stale.
    expect(PROOFS.length, 'the file has stopped proving things').toBeGreaterThanOrEqual(30);
    for (const p of PROOFS) {
      expect(p, p).toMatch(/^\(SELECT /);
      expect(p, p).toMatch(/\)$/);
      expect(balanced(p), `unbalanced parentheses in a proof: ${p}`).toBe(true);
      expect(p, `a proof that is two statements: ${p}`).not.toMatch(/;\s*\S/);
    }
  });

  it('strips comments from every function body a proof text-matches against', () => {
    // THE REGRESSION TEST FOR A DEFECT CLASS, NOT FOR AN INCIDENT. Three proofs
    // in this project went false because the body they read with
    // pg_get_functiondef quoted, IN A COMMENT, the exact string the proof
    // forbade. The comment was the right thing to have written and the proof was
    // the wrong way to ask. This migration's bodies are heavily commented and
    // several of those comments name is_horse, table_seats and
    // fn_cash_cluster_begin_pending_on, so any proof that applies a text
    // operator to a function definition must strip first.
    const TEXT_OPERATORS = ['position(', ' ~ ', ' !~ ', 'regexp_matches'];
    let wrapped = 0;
    for (const p of PROOFS) {
      if (!p.includes('pg_get_functiondef')) continue;
      if (!TEXT_OPERATORS.some((op) => p.includes(op))) continue;
      expect(p, `this proof reads a body as text without stripping its comments: ${p}`).toContain(
        'regexp_replace'
      );
      wrapped++;
    }
    expect(
      wrapped,
      'no proof reads a body as text, so this rule is vacuous'
    ).toBeGreaterThanOrEqual(7);
    expect(PROOFS.join('\n')).toContain("'--[^' || chr(10) || ']*', '', 'g'");
    // The proofs cover the things a source test cannot: the halt columns and
    // their pairing in the live estate, the partial unique index, the three
    // functions and their definer bit, the grants as the catalogue records them,
    // the two stand-downs in the LIVE bodies, Law 10.5 in both of them, and the
    // capability gate.
    const all = PROOFS.join('\n');
    for (const claim of [
      'dealing_halted_at',
      'dealing_halted_reason',
      'cash_cluster_conversion',
      'relrowsecurity',
      'role_routine_grants',
      'has_function_privilege',
      'prosecdef',
      'lightning_cluster_stands_down',
      'is_horse',
      'lightning_pool_session',
      'tables_dealing_halt_is_explained',
    ]) {
      expect(all, `nothing is proved about ${claim} against the live database`).toContain(claim);
    }
  });

  it('declares its new table, columns and functions in its own manifest fragment', () => {
    // scripts/ci/supabase-schema-manifest.json was the single most-changed file
    // on main - every agent shipping a migration had to append to the same
    // sorted array, so any two such branches conflicted by construction. The
    // fragment directory is the cure, and a migration that creates objects
    // without declaring them leaves the CI gates unable to see them.
    const FRAGMENT = path.join(
      ROOT,
      'scripts',
      'ci',
      'schema-manifest.d',
      'lightning-phase5-conversion.json'
    );
    expect(fs.existsSync(FRAGMENT), 'this migration declares nothing it created').toBe(true);
    const frag = JSON.parse(fs.readFileSync(FRAGMENT, 'utf8'));
    expect(frag.tables).toContain('cash_cluster_conversion');
    // FIVE FUNCTIONS, AND THE FIFTH IS DISCOVERED RATHER THAN LISTED. Four are
    // written out with CREATE OR REPLACE; the fifth is re-cut by the section 5c
    // asserted substitution and never appears as a CREATE in this file at all,
    // so its name is read out of the block that substitutes it. A migration
    // that re-cuts a function and does not declare it leaves the CI gates
    // unable to see that it changed at all.
    const POP_TARGET = /pg_get_functiondef\('public\.(\w+)\(/.exec(POP)?.[1];
    expect(POP_TARGET, 'the substitution block no longer names what it re-cuts').toBeTruthy();
    expect(frag.functions.slice().sort()).toEqual(
      [...FUNCTIONS.map((f) => f.name), POP_TARGET as string].sort()
    );
    expect(frag.columns.tables).toEqual(
      expect.arrayContaining(['dealing_halted_at', 'dealing_halted_reason'])
    );
    // Every column of the new table is declared, driven off the CREATE TABLE
    // rather than off a list, so a tenth column added later cannot go undeclared.
    const CREATE = span(CODE, 'CREATE TABLE IF NOT EXISTS public.cash_cluster_conversion', ');');
    const cols = [...CREATE.matchAll(/^\s{2}(\w+)\s+\w/gm)].map((m) => m[1]);
    expect(cols.length).toBeGreaterThanOrEqual(14);
    for (const c of cols) {
      expect(
        frag.columns.cash_cluster_conversion,
        `the fragment does not declare cash_cluster_conversion.${c}`
      ).toContain(c);
    }
  });

  it('is wired into the accounting job, immediately after its Phase 4 sibling', () => {
    // A WIRED STEP THAT POINTS AT NOTHING IS A RED CI RUN AND NOTHING ELSE, so
    // the path is checked against the disk as well as against the workflow. The
    // step runs AFTER the Phase 4 remediation harness because this migration is
    // applied on top of 20260921142954 - its own fixture chain depends on the
    // verdict that file repaired, without which every conversion would abort at
    // its own re-check.
    expect(
      fs.existsSync(path.join(ROOT, 'scripts/dev/test-lightning-phase5-conversion.sh')),
      'ci.yml runs a harness that is not in the tree'
    ).toBe(true);
    const ACCOUNTING = jobBlock('accounting_postgres');
    expect(ACCOUNTING, 'there is no accounting_postgres job in the workflow').toBeTruthy();
    const harnesses = [
      ...ACCOUNTING.matchAll(/run: bash (scripts\/dev\/test-lightning-[\w-]+\.sh)/g),
    ].map((m) => m[1]);
    expect(harnesses).toContain('scripts/dev/test-lightning-phase5-conversion.sh');
    expect(harnesses.indexOf('scripts/dev/test-lightning-phase5-conversion.sh')).toBe(
      harnesses.indexOf('scripts/dev/test-lightning-phase4-remediation.sh') + 1
    );
    // Every Lightning harness runs with the same PG_BIN the rest of the job
    // uses, so the new step cannot silently pick up a different PostgreSQL.
    expect(ACCOUNTING).toContain(
      '      - name: Lightning Phase 5 converts a must-move cluster in one transaction and stands the tick down\n' +
        '        env:\n' +
        '          PG_BIN: /usr/lib/postgresql/17/bin\n' +
        '        run: bash scripts/dev/test-lightning-phase5-conversion.sh'
    );
    // The harness gates merge through the `server` job, which is a required
    // check and needs this one.
    const SERVER = jobBlock('server');
    const needs = (SERVER.match(/^ {4}needs:\s*\[([^\]]*)\]/m)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim());
    expect(needs, 'the required check no longer needs the accounting job').toContain(
      'accounting_postgres'
    );
  });
});
