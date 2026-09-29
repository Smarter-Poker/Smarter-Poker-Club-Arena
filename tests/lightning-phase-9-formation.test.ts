/**
 * LIGHTNING 2.0 PHASE 9: THE HAND FORMATION BARRIER IS ATOMIC, AND THE
 * PARTICIPANT SET IS LOCKED THE MOMENT IT IS COMPLETE.
 *
 * 20260925215731 gives the six Lightning tables that had no writer at all their
 * first writers: a pool slot opened on pool entry, an instance born with a
 * deadline, one barrier function that performs specification steps 1 to 10 in
 * one block whose failure un-creates everything, a one-way latch that the four
 * post-barrier "no" rules key off, and a reaper. Everything below is a static
 * reading of that ONE migration. The harness
 * `scripts/dev/test-lightning-phase9-formation.sh` proves the same claims
 * against a running catalogue and a running estate; this file proves the ones a
 * catalogue cannot see - the transaction shape, which guard belongs to which
 * constraint, which statement comes before which, and that the words a rule
 * forbids are absent from CODE rather than merely from the comments around it.
 *
 * SCOPE. This file reads 20260925215731 and nothing after it. An adversarial
 * audit after apply found defects in it that a follow-up remediation migration
 * repairs; that migration gets its own suite. Nothing here asserts a defect is
 * present, and nothing here asserts the remediation's shape.
 *
 * THE STRIP. Like its Phase 5 sibling this file uses a literal-aware scan
 * rather than a regex strip, because a rule about CODE must not be satisfied or
 * broken by prose: this migration's COMMENT ON literals say "Deliberately NOT
 * gated on fn_platform_frozen()" and "the shuffle and the deal", and its
 * function bodies carry comments that name is_horse. Section 2 asserts the scan
 * is doing work on this file, in both directions.
 *
 * LIGHTNING_P9_MIGRATION overrides the file under test and LIGHTNING_P9_CHANGELOG
 * the changelog entry, so mutation testing - copying either to a scratch
 * directory, breaking one line of the copy and watching this suite go red -
 * never touches the repository. It is the same mechanism as
 * LIGHTNING_P5_MIGRATION.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const FILE = '20260925215731_lightning_phase_9_the_hand_formation_barrier_is_atomic_and_t.sql';
const MIGRATION = process.env.LIGHTNING_P9_MIGRATION ?? path.join(MIGRATIONS, FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const CHANGELOG_PATH =
  process.env.LIGHTNING_P9_CHANGELOG ??
  path.join(ROOT, 'docs', 'changelog', '2026-09-25-lightning-phase-9-formation.md');
const CHANGELOG = fs.readFileSync(CHANGELOG_PATH, 'utf8');
/** The Phase 2 migration that created the tables whose CHECKs this file extends. */
const P2_SQL = fs.readFileSync(
  path.join(
    MIGRATIONS,
    '20260920235343_lightning_phase_2_the_pool_the_instance_the_reservation_and_.sql'
  ),
  'utf8'
);

/**
 * One left-to-right scan producing both stripped forms at once, exactly as the
 * Phase 5 suite does it.
 *
 *   `code` - line comments removed, newlines and every literal kept.
 *   `biz`  - the same, with single-quoted literals blanked to spaces of the
 *            same length, so offsets survive and a rule about CODE cannot be
 *            satisfied or broken by a sentence that happens to sit in quotes.
 *
 * A `--` inside a literal is not a comment, and a dollar-quote delimiter is
 * transparent: every function under test lives inside `$fn$ ... $fn$`.
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
    const dollar = /^\$\w*\$/.exec(sql.slice(i, i + 40)); // window-ok: not a source pin - a dollar-quote OPENING TAG, $tag$, cannot be longer than this, so this is a bounded lookahead for a token and nothing downstream of it is asserted
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
const blankLiterals = (s: string): string => scan(s).biz;
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
const count = (hay: string, re: RegExp): number => (hay.match(re) ?? []).length;

/**
 * EVERY FUNCTION THIS FILE WRITES OUT, DISCOVERED RATHER THAN LISTED. The grant,
 * definer, freeze and money rules below are all driven off this, so a sixteenth
 * function added later cannot slip past any of them by not being in a list.
 */
const FUNCTIONS = [
  ...SQL.matchAll(
    /^CREATE OR REPLACE FUNCTION\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*RETURNS\s+([\s\S]*?)\bAS\s+(\$\w*\$)([\s\S]*?)\4;/gm
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

const FORM = fnOf('fn_lightning_form_hand');
const REAP = fnOf('fn_lightning_reap_formations');
const OPEN = fnOf('fn_lightning_instance_open');
const SYNC = fnOf('fn_lightning_pool_slots_sync');
const P2 = fnOf('fn_lightning_blind_order');

/** Every @live-proof, harvested from line-anchored header lines, and the raw lines. */
const PROOF_LINES = SQL.split('\n').filter((l) => /^-- @live-proof:/.test(l));
const PROOFS = [...SQL.matchAll(/^--\s*@live-proof:\s*(.+?)\s*$/gm)].map((m) => m[1]);

/** Parentheses balance, literals blanked first so a quoted `\(` is not structure. */
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

/** From an opening parenthesis at `at`, the text up to and including its match. */
const parenFrom = (s: string, at: number): string => {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return s.slice(at, i + 1);
    }
  }
  return '';
};

/** Split at a keyword that sits at paren depth zero. */
const splitTop = (s: string, word: 'OR' | 'AND'): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  const re = new RegExp(`\\s${word}\\s`, 'y');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (depth === 0) {
      re.lastIndex = i;
      if (re.test(s)) {
        parts.push(s.slice(last, i));
        last = re.lastIndex;
        i = re.lastIndex - 1;
      }
    }
  }
  parts.push(s.slice(last));
  return parts.map((p) => p.trim());
};

/** Strip parentheses that enclose the whole expression, as many times as they do. */
const unwrap = (s: string): string => {
  let t = s.trim();
  while (t.startsWith('(') && parenFrom(t, 0).length === t.length) t = t.slice(1, -1).trim();
  return t;
};

/** The DO blocks, as offsets into CODE. */
const DO_BLOCKS = [...CODE.matchAll(/DO (\$\w+\$)[\s\S]*?END\s*\1;/g)].map((m) => ({
  start: m.index ?? -1,
  end: (m.index ?? -1) + m[0].length,
}));
const insideDo = (at: number): boolean => DO_BLOCKS.some((b) => at > b.start && at < b.end);

/** The existence guard immediately in front of `at`: from the last IF NOT EXISTS to `at`. */
const guardBefore = (at: number): string => {
  const g = CODE.lastIndexOf('IF NOT EXISTS (', at);
  return g < 0 ? '' : CODE.slice(g, at);
};

/** Any write, in any spelling, to a table whose rows are money or the record of it. */
const MONEY_WRITE =
  /\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:public\.)?(table_seats|wallets|club_wallets|union_wallets|chip_ledger|ca_settlements|cash_player_session|lightning_pool_session)\b/i;

const FROZEN_CALL = /\bpublic\.fn_platform_frozen\(\)/;

// ===========================================================================
//  1. THE SHAPE OF THE CHANGE
// ===========================================================================

describe('Phase 9: one transaction, one ADD COLUMN per ALTER TABLE, every guard on its own name', () => {
  it('is exactly one transaction and writes out fifteen functions, discovered', () => {
    // Counted over CODE, because every plpgsql body opens with a bare BEGIN and
    // the barrier carries an inner BEGIN ... EXCEPTION block; none of those is a
    // transaction and none may be counted as one.
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE).not.toMatch(/^ROLLBACK;$/m);
    expect(CODE.indexOf('BEGIN;')).toBeLessThan(CODE.indexOf('ALTER TABLE'));
    expect(CODE.lastIndexOf('COMMIT;')).toBeGreaterThan(CODE.lastIndexOf('COMMENT ON FUNCTION'));
    expect(count(CODE, /CREATE OR REPLACE FUNCTION/g)).toBe(FUNCTIONS.length);
    expect(FUNCTIONS.length, 'the function parser found nothing to check').toBeGreaterThanOrEqual(
      15
    );
  });

  it('sets its lock timeout inside the transaction before the first DDL, or the changelog records that it does not', () => {
    // Every Lightning migration from 20260921025504 on carries SET LOCAL
    // lock_timeout, because an ALTER TABLE that queues behind a long reader
    // blocks every query that queues behind IT. This one does not: it takes
    // ACCESS EXCLUSIVE on lightning_instance and lightning_hand four times with
    // no bound on the wait. The file is applied and immutable, so the honest
    // assertion is a disjunction: either the statement is there and in the
    // right place, or the gap is written down where the next reader will look.
    const at = CODE.search(/SET LOCAL lock_timeout\s*=\s*'\d+m?s'\s*;/);
    if (at >= 0) {
      expect(at, 'the lock timeout is set before the transaction opens').toBeGreaterThan(
        CODE.indexOf('BEGIN;')
      );
      expect(at, 'the lock timeout is set after DDL has already queued').toBeLessThan(
        CODE.indexOf('ALTER TABLE')
      );
    } else {
      expect(CHANGELOG, 'no lock timeout, and the changelog does not say so').toMatch(
        /`SET LOCAL lock_timeout`/
      );
      expect(CHANGELOG).toMatch(/## Found in review/);
    }
  });

  it('adds one column per ALTER TABLE, every one IF NOT EXISTS, and every index IF NOT EXISTS', () => {
    // Every DDL statement fires a PostgREST schema reload of roughly 28 seconds
    // here, and a multi-clause ALTER hides which clause failed. Asserted per
    // statement, so a fifth column cannot be folded into an existing ALTER.
    const alters = [...CODE.matchAll(/ALTER TABLE[\s\S]*?;/g)].map((m) => m[0]);
    expect(alters.length, 'the ALTER TABLE parser found nothing').toBeGreaterThanOrEqual(7);
    for (const a of alters) {
      expect(count(a, /ADD COLUMN/g), `more than one ADD COLUMN: ${flat(a)}`).toBeLessThanOrEqual(
        1
      );
      expect(a, `a multi-clause ALTER TABLE: ${flat(a)}`).not.toMatch(/,\s*(ADD|ALTER|DROP)\b/);
      if (/ADD COLUMN/.test(a)) {
        expect(a, `an ADD COLUMN that applies exactly once: ${flat(a)}`).toMatch(
          /ADD COLUMN IF NOT EXISTS/
        );
      }
    }
    expect(alters.filter((a) => /ADD COLUMN/.test(a)).length).toBeGreaterThanOrEqual(4);
    // An instance cannot be created without a deadline: NOT NULL with a default.
    expect(flat(CODE)).toContain(
      "ALTER TABLE public.lightning_instance ADD COLUMN IF NOT EXISTS deadline_at timestamp with time zone NOT NULL DEFAULT (clock_timestamp() + interval '45 seconds');"
    );
    expect(count(CODE, /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/g)).toBeGreaterThanOrEqual(3);
    expect(CODE, 'an index without IF NOT EXISTS applies exactly once').not.toMatch(
      /CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/
    );
    expect(CODE).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|INDEX|TRIGGER|CONSTRAINT)\b/i);
  });

  it('guards EVERY ADD CONSTRAINT with an existence check on its own name and its own table', () => {
    // ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS in PostgreSQL 17. The
    // guard is paired by NAME and TABLE, and it must be the guard IMMEDIATELY in
    // front of the statement: a DO block with three guards could otherwise let
    // the third constraint borrow the first one's.
    const adds = [...CODE.matchAll(/ALTER TABLE public\.(\w+)\s+ADD CONSTRAINT (\w+)/g)];
    expect(adds.length, 'this migration has stopped adding constraints').toBeGreaterThanOrEqual(3);
    expect(count(CODE, /ADD CONSTRAINT/g), 'an ADD CONSTRAINT the parser did not see').toBe(
      adds.length
    );
    for (const a of adds) {
      const at = a.index ?? -1;
      const [, table, name] = a;
      expect(insideDo(at), `ADD CONSTRAINT ${name} is not inside a DO block`).toBe(true);
      const g = guardBefore(at);
      expect(g, `ADD CONSTRAINT ${name} has no existence check in front of it`).toMatch(
        /^IF NOT EXISTS \(SELECT 1 FROM pg_constraint/
      );
      expect(g, `${name}'s guard belongs to another statement`).not.toMatch(/END IF;/);
      expect(g, `${name} is guarded by a check for a different constraint`).toContain(
        `conname = '${name}'`
      );
      expect(g, `${name} is guarded on the wrong table`).toContain(
        `conrelid = 'public.${table}'::regclass`
      );
    }
  });

  it('guards EVERY CREATE TRIGGER with an existence check on its own name and its own table', () => {
    // CREATE TRIGGER without OR REPLACE applies exactly once, and a trigger
    // guarded on the wrong table would be silently skipped on the right one.
    const trgs = [
      ...CODE.matchAll(/CREATE TRIGGER (\w+)\s+(?:BEFORE|AFTER)[\s\S]*?\bON public\.(\w+)/g),
    ];
    expect(trgs.length, 'this migration has stopped creating triggers').toBeGreaterThanOrEqual(6);
    expect(count(CODE, /CREATE (?:OR REPLACE )?TRIGGER/g)).toBe(trgs.length);
    for (const t of trgs) {
      const at = t.index ?? -1;
      const [, name, table] = t;
      expect(insideDo(at), `CREATE TRIGGER ${name} is not inside a DO block`).toBe(true);
      const g = guardBefore(at);
      expect(g, `CREATE TRIGGER ${name} has no existence check in front of it`).toMatch(
        /^IF NOT EXISTS \(SELECT 1 FROM pg_trigger/
      );
      expect(g, `${name}'s guard belongs to another statement`).not.toMatch(/END IF;/);
      expect(g, `${name} is guarded by a check for a different trigger`).toContain(
        `tgname = '${name}'`
      );
      expect(g, `${name} is guarded on the wrong table`).toContain(
        `tgrelid = 'public.${table}'::regclass`
      );
    }
  });

  it('makes rule 725 two indexes, on (cluster_id, player_id), and says out loud what that narrows', () => {
    expect(flat(CODE)).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS lightning_reservation_one_active_per_player ON public.lightning_reservation (cluster_id, player_id) WHERE state IN ('pending', 'committed');"
    );
    expect(flat(CODE)).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS lightning_pool_slot_one_open_per_player ON public.lightning_pool_slot (cluster_id, player_id) WHERE closed_at IS NULL;'
    );
    // The single-slot pool is a real narrowing of the schema's intent. The file
    // says so, and the slot opener writes slot 1 and nothing else.
    expect(SQL).toMatch(/Rule 725\s+-- and a multi-slot pool cannot both be true/);
    expect(fnOf('fn_lightning_pool_slot_open').body).toMatch(
      /VALUES \(ps\.id, ps\.cluster_id, ps\.cluster_epoch, ps\.player_id, 1, p_now, p_now\)/
    );
  });
});

// ===========================================================================
//  2. THE STRIPS ARE PROVEN TO BE DOING WORK, IN BOTH DIRECTIONS
// ===========================================================================

describe('Phase 9: comments and literals are blanked, and the blanking is load-bearing', () => {
  it('removes real comments and blanks real literals without touching real code', () => {
    // THE CONTROLS. A strip that blanked everything would satisfy every absence
    // assertion in this file, so both strips are run over a probe carrying the
    // same forbidden string as code, as a comment and as a literal.
    const probe =
      "UPDATE public.chip_ledger SET amount = 0; -- UPDATE chip_ledger\nSELECT 'UPDATE chip_ledger';\n";
    const p = scan(probe);
    expect(p.code, 'the strip ate real code').toContain(
      'UPDATE public.chip_ledger SET amount = 0;'
    );
    expect(p.code, 'the comment survived the strip').not.toContain('-- UPDATE chip_ledger');
    expect(count(p.code, /UPDATE chip_ledger/g), 'the literal was blanked by the wrong pass').toBe(
      1
    );
    expect(p.biz, 'blanking the literals ate real code').toMatch(MONEY_WRITE);
    expect(count(p.biz, /UPDATE chip_ledger/g), 'a literal survived the blanking').toBe(0);
    expect(p.biz.length, 'blanking changed the offsets').toBe(p.code.length);
    expect(scan("SELECT 'it''s -- fine', 1;\n").code).toBe("SELECT 'it''s -- fine', 1;\n");
  });

  it('is doing work on this migration in both directions, measured rather than assumed', () => {
    // THE COMMENT STRIP, ON A REAL BODY. The sync pass explains in a comment
    // that it has no is_horse; raw, the body names the column, stripped it does
    // not. If that comment is ever removed this line goes red and the paragraph
    // stops being true, which is the point.
    expect(SYNC.raw, 'the sync body no longer names is_horse in prose').toMatch(/\bis_horse\b/);
    expect(SYNC.body, 'the comment strip is not removing the prose it claims to').not.toMatch(
      /\bis_horse\b/
    );
    expect(count(SQL, /\bis_horse\b/g)).toBeGreaterThan(count(CODE, /\bis_horse\b/g));

    // THE LITERAL BLANK, ON THE REAL FILE. The reaper's COMMENT ON says it is
    // "Deliberately NOT gated on fn_platform_frozen()", and the barrier's says
    // "the shuffle and the deal". Both are literals, so CODE carries them and
    // BIZ must not, or the freeze rule and the no-shuffle rule below would be
    // tripped by prose about themselves.
    expect(CODE, 'the COMMENT no longer quotes the freeze call').toMatch(
      /'[^']*NOT gated on fn_platform_frozen\(\)/
    );
    expect(count(CODE, /fn_platform_frozen\(\)/g)).toBeGreaterThan(
      count(BIZ, /fn_platform_frozen\(\)/g)
    );
    expect(CODE, 'no literal mentions the shuffle any more, so BIZ proves nothing').toMatch(
      /\bshuffle\b/
    );
    expect(BIZ).not.toMatch(/\bshuffle\b/);
  });
});

// ===========================================================================
//  3. SERVICE_ROLE ONLY, INVOKER ONLY, DRIVEN OFF A REGEX
// ===========================================================================

describe('Phase 9: every function it writes is revoked, granted to service_role, and an invoker', () => {
  it('revokes and grants EVERY function it writes, counted from both ends', () => {
    // Driven off the discovered set, so a function added later arrives with a
    // pair or turns this red. Counted from both ends, so neither a missing pair
    // nor a stray one naming something this file does not write can pass.
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
    expect(BIZ, 'something in this file grants a browser role').not.toMatch(
      /GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i
    );
    expect(count(BIZ, /\bTO service_role;/g)).toBe(count(BIZ, /\bGRANT\b/g));
  });

  it('makes no function SECURITY DEFINER, pins every search_path, and argues the choice', () => {
    // SPECIFICATION 532 AND THE ARGUMENT FOR INVOKER. service_role carries
    // BYPASSRLS and the lightning tables are granted to it alone, so a definer
    // would add an owner-privileged surface and buy nothing. A definer added
    // later must come with its own argument in the file, by name.
    for (const f of FUNCTIONS) {
      expect(f.attrs, `${f.name} does not pin its search_path`).toContain(
        "SET search_path TO 'public', 'pg_temp'"
      );
      if (/SECURITY DEFINER/.test(f.attrs)) {
        expect(SQL, `${f.name} is a definer and nothing in the file argues why`).toMatch(
          new RegExp(`${f.name}[^\\n]*\\bis SECURITY DEFINER because\\b`)
        );
      }
    }
    expect(FUNCTIONS.filter((f) => /SECURITY DEFINER/.test(f.attrs)).map((f) => f.name)).toEqual(
      []
    );
    expect(SQL).toMatch(/every one of them is\s+-- SECURITY INVOKER/);
    expect(SQL).toMatch(/SECURITY DEFINER would buy except/);
  });
});

// ===========================================================================
//  4. LAW 10.5, THE MONEY, AND THE ENGINE'S HALF
// ===========================================================================

describe('Phase 9: a horse is a player, forming moves no money, and the deal is not here', () => {
  it('has no is_horse anywhere in code - no predicate, no ordering, no filter (Law 10.5)', () => {
    expect(BIZ, 'is_horse appears in code').not.toMatch(/\bis_horse\b/);
    for (const f of FUNCTIONS) {
      expect(f.biz, `${f.name} filters on is_horse`).not.toMatch(/\bis_horse\b/);
      expect(f.biz, `${f.name} reads a horse column`).not.toMatch(/\bhorse_id\b/);
    }
    // Non-vacuity: the file does talk about the law, in prose and in a proof.
    expect(count(SQL, /\bis_horse\b/g)).toBeGreaterThanOrEqual(3);
  });

  it('writes no seat, wallet, ledger, cash session or pool session in any function', () => {
    for (const f of FUNCTIONS) {
      expect(f.biz, `${f.name} writes a money-bearing table`).not.toMatch(MONEY_WRITE);
    }
    expect(BIZ, 'something outside a function writes a money-bearing table').not.toMatch(
      MONEY_WRITE
    );
    // Non-vacuity: the barrier READS the pool session twice - the chip total
    // before and after - and raises, uncaught, if they differ.
    expect(count(FORM.biz, /FROM public\.lightning_pool_session\b/g)).toBeGreaterThanOrEqual(2);
    expect(FORM.body).toContain('INTO v_before FROM public.lightning_pool_session');
    expect(FORM.body).toContain('INTO v_after FROM public.lightning_pool_session');
    expect(FORM.body).toContain('IF v_after IS DISTINCT FROM v_before THEN');
    expect(FORM.body).toMatch(/RAISE EXCEPTION 'LIGHTNING_FORMATION_MOVED_MONEY/);
    // The money check sits AFTER the atomic block, outside its handler, so that
    // money moving is never mistaken for a retryable refusal.
    expect(FORM.biz.indexOf('IF v_after IS DISTINCT FROM v_before')).toBeGreaterThan(
      FORM.biz.search(/\bEXCEPTION\s+WHEN\b/)
    );
  });

  it('records blind roles in the ledger and writes none of its debt columns', () => {
    // missed_bb_debt, bb_owed and sb_owed are obligations discharged when a
    // blind is POSTED, and posting is the engine's. The barrier counts roles.
    const ins = /INSERT INTO public\.lightning_blind_ledger\s*\(([^)]*)\)/.exec(FORM.biz);
    expect(ins, 'the barrier no longer records blind roles').toBeTruthy();
    const onConflict = /ON CONFLICT \(cluster_id, player_id\) DO UPDATE SET([\s\S]*?);/.exec(
      FORM.biz
    );
    expect(onConflict, 'the ledger upsert is gone').toBeTruthy();
    const DEBT = /\b(missed_bb_debt|missed_sb_debt|bb_owed|sb_owed)\b/;
    expect(ins?.[1], 'the ledger insert writes a debt column').not.toMatch(DEBT);
    expect(onConflict?.[1], 'the ledger upsert writes a debt column').not.toMatch(DEBT);
    for (const f of FUNCTIONS) {
      expect(f.biz, `${f.name} UPDATEs the blind ledger`).not.toMatch(
        /UPDATE\s+(?:public\.)?lightning_blind_ledger\b/
      );
    }
    expect(ins?.[1]).toMatch(/\bbb_count\b/);
  });

  it('leaves steps 11 and 12 - the shuffle and the deal - to the engine', () => {
    // A hole card that were a row here would be a hole card every replica
    // could read. No RNG call, no deck, no card.
    expect(BIZ).not.toMatch(/\b(random|setseed)\s*\(/i);
    expect(BIZ).not.toMatch(/\b(deck|hole_cards?|shuffle)\b/i);
    // The only randomness is the hand's identity.
    expect(count(FORM.biz, /gen_random_uuid\(\)/g)).toBe(1);
    expect(SQL).toMatch(
      /This file builds ONE to TEN,\s+-- and it builds the PRECONDITION of thirteen/
    );
  });

  it('consults P2 through the one function that owns the key, and does not reimplement it', () => {
    expect(FORM.biz).toContain('public.fn_lightning_blind_order(g.id, v_epoch, v_legal)');
    expect(FUNCTIONS.filter((f) => /NULLS FIRST/.test(f.biz)).map((f) => f.name)).toEqual([
      P2.name,
    ]);
    expect(P2.biz).toMatch(/sl\.last_bb_at ASC NULLS FIRST/);
    expect(P2.attrs).toMatch(/\bSTABLE\b/);
  });
});

// ===========================================================================
//  5. THE FREEZE GATES ENTRY AND NEVER GATES RECOVERY
// ===========================================================================

describe('Phase 9: the barrier gates on fn_platform_frozen and the reaper does not', () => {
  it('gates exactly the five doors in, and none of the roads out', () => {
    // Driven off every function, so a sixth that starts asking the freeze, or
    // the reaper learning to, turns this red.
    const gated = FUNCTIONS.filter((f) => FROZEN_CALL.test(f.biz))
      .map((f) => f.name)
      .sort();
    expect(gated).toEqual(
      [
        'fn_lightning_form_hand',
        'fn_lightning_instance_begin_dealing',
        'fn_lightning_instance_open',
        'fn_lightning_pool_slot_open',
        'fn_lightning_pool_slots_sync',
      ].sort()
    );
    for (const name of [
      'fn_lightning_reap_formations',
      'fn_lightning_instance_abandon',
      'fn_lightning_instance_releases_its_reservations',
    ]) {
      expect(fnOf(name).biz, `${name} is gated on the freeze`).not.toMatch(/fn_platform_frozen/);
    }
  });

  it('asks the freeze before it locks anything or writes anything', () => {
    const frozen = FORM.biz.search(FROZEN_CALL);
    const lock = FORM.biz.indexOf('FOR UPDATE');
    const firstWrite = FORM.biz.search(/INSERT INTO public\.lightning_instance\b/);
    expect(frozen).toBeGreaterThan(0);
    expect(frozen, 'the barrier locks the Cluster before asking the freeze').toBeLessThan(lock);
    expect(lock, 'the barrier writes before it locks the Cluster').toBeLessThan(firstWrite);
    // THE CLUSTER ROW IS THE FIRST LOCK, and the epoch is read under it.
    expect(FORM.biz).toMatch(/FROM public\.cash_games WHERE id = p_cluster_id FOR UPDATE;/);
    expect(FORM.biz.indexOf('FROM public.cash_games')).toBeLessThan(
      FORM.biz.indexOf('v_epoch := g.cluster_epoch')
    );
  });

  it('closes departed slots BEFORE the freeze return in the sync pass, because closing is recovery', () => {
    const close = SYNC.biz.search(/UPDATE public\.lightning_pool_slot\b/);
    const stop = SYNC.biz.indexOf('IF v_frozen THEN');
    expect(close, 'the sync pass no longer closes anything').toBeGreaterThan(0);
    expect(stop, 'the sync pass no longer honours the freeze').toBeGreaterThan(0);
    expect(close, 'closing a departed slot is gated on the freeze').toBeLessThan(stop);
    expect(SYNC.biz.indexOf('fn_lightning_pool_slot_open(')).toBeGreaterThan(stop);
  });

  it('reaps the Cluster before opening a new instance, and every instance is born with a deadline', () => {
    const reap = OPEN.biz.indexOf('public.fn_lightning_reap_formations(');
    const ins = OPEN.biz.search(/INSERT INTO public\.lightning_instance\b/);
    expect(reap).toBeGreaterThan(0);
    expect(reap, 'the next formation no longer buries the last one first').toBeLessThan(ins);
    const inserts = FUNCTIONS.flatMap((f) =>
      [...f.biz.matchAll(/INSERT INTO public\.lightning_instance\s*\(([^)]*)\)/g)].map((m) => ({
        name: f.name,
        cols: m[1],
      }))
    );
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    for (const i of inserts) {
      expect(i.cols, `${i.name} creates an instance without naming its deadline`).toMatch(
        /\bdeadline_at\b/
      );
    }
    expect(REAP.biz).toMatch(/FOR UPDATE SKIP LOCKED/);
  });
});

// ===========================================================================
//  6. THE LATCH AND THE CHECKS
// ===========================================================================

describe('Phase 9: the four no-rules key off one latch, and no CHECK passes by being NULL', () => {
  it('names all four no-rules against participants_locked_at, and the latch is one-way', () => {
    const HP = fnOf('fn_lightning_hand_player_is_immutable');
    for (const code of [
      'LIGHTNING_NO_PARTICIPANT_SUBSTITUTION',
      'LIGHTNING_NO_SILENT_SEAT_SWAP',
      'LIGHTNING_NO_BLIND_REASSIGNMENT',
      'LIGHTNING_NO_ADDITIONAL_PLAYER_INSERTION',
    ]) {
      expect(HP.body, `${code} is not raised`).toContain(`RAISE EXCEPTION '${code}`);
    }
    expect(HP.biz).toContain('SELECT h.participants_locked_at INTO v_locked');
    // fold_type and stack_after are the hand being played and stay writable.
    expect(HP.biz).not.toMatch(/NEW\.(fold_type|stack_after) IS DISTINCT FROM/);
    const H = fnOf('fn_lightning_hand_is_immutable');
    expect(flat(H.biz)).toContain(
      'IF OLD.participants_locked_at IS NOT NULL AND NEW.participants_locked_at IS DISTINCT FROM OLD.participants_locked_at THEN'
    );
    // The latch and its count move in one statement in the barrier.
    expect(flat(FORM.biz)).toContain(
      'SET participants_locked_at = p_now, player_count = v_n::smallint'
    );
  });

  it('guards every nullable column a CHECK compares, in the same OR arm', () => {
    // A CHECK THAT EVALUATES TO NULL PASSES. So every column a CHECK compares
    // must either be NOT NULL in the schema or be asserted IS NOT NULL in the
    // same arm; a column tested only with IS [NOT] NULL is not an operand.
    // Nullability is read from the Phase 2 CREATE TABLE and this file's own
    // ADD COLUMN, not from a list.
    const P2CODE = scan(P2_SQL).code;
    const columnsOf = (table: string): Map<string, boolean> => {
      const cols = new Map<string, boolean>();
      const create = new RegExp(
        `CREATE TABLE IF NOT EXISTS public\\.${table} \\(([\\s\\S]*?)\\n\\);`
      ).exec(P2CODE);
      for (const m of (create?.[1] ?? '').matchAll(/^\s{2}(\w+)\s+(\w+)([^\n]*)$/gm)) {
        if (m[1] === 'CONSTRAINT') continue;
        cols.set(m[1], /NOT NULL|PRIMARY KEY/.test(m[3]));
      }
      for (const m of CODE.matchAll(
        new RegExp(`ALTER TABLE public\\.${table}\\s+ADD COLUMN IF NOT EXISTS (\\w+)([^;]*);`, 'g')
      )) {
        cols.set(m[1], /NOT NULL/.test(m[2]));
      }
      return cols;
    };
    const checks = [
      ...BIZ.matchAll(/ALTER TABLE public\.(\w+)\s+ADD CONSTRAINT (\w+)\s+CHECK\s*(?=\()/g),
    ];
    expect(checks.length, 'this file has stopped adding CHECKs').toBeGreaterThanOrEqual(3);
    let guardedUses = 0;
    for (const c of checks) {
      const [, table, name] = c;
      const cols = columnsOf(table);
      expect(cols.size, `the schema of ${table} could not be read`).toBeGreaterThan(5);
      const expr = parenFrom(BIZ, (c.index ?? 0) + c[0].length);
      expect(expr, `${name}: the CHECK could not be read`).toBeTruthy();
      for (const arm of splitTop(unwrap(expr), 'OR')) {
        const conj = splitTop(unwrap(arm), 'AND').map(unwrap);
        const guarded = new Set(
          conj.map((k) => /^(\w+) IS NOT NULL$/.exec(k)?.[1]).filter((x): x is string => !!x)
        );
        for (const k of conj) {
          if (/^\w+ IS (NOT )?NULL$/.test(k)) continue;
          for (const id of k.match(/\b[a-z_]+\b/g) ?? []) {
            if (!cols.has(id)) continue;
            if (cols.get(id)) continue;
            expect(
              guarded.has(id),
              `${name}: nullable ${table}.${id} is compared in "${flat(k)}" with no IS NOT NULL in its arm`
            ).toBe(true);
            guardedUses++;
          }
        }
      }
    }
    // Non-vacuity: the rule really did meet a nullable operand, and it was guarded.
    expect(
      guardedUses,
      'no nullable operand was checked, so this rule is vacuous'
    ).toBeGreaterThanOrEqual(3);
  });
});

// ===========================================================================
//  7. THE PROOFS
// ===========================================================================

describe('Phase 9: it proves what it says, and its catalogue scans can run', () => {
  it('declares live proofs, every one a balanced parenthesised SELECT, as a floor', () => {
    // A FLOOR, NEVER AN EQUALITY - the house rule, because a count written in
    // prose goes stale. What IS exact is that the extraction and the raw lines
    // agree, so a proof cannot be silently dropped by the harvesting regex.
    expect(PROOFS.length, 'the extraction lost a proof line').toBe(PROOF_LINES.length);
    expect(PROOFS.length, 'the file has stopped proving things').toBeGreaterThanOrEqual(34);
    for (const p of PROOFS) {
      expect(p, p).toMatch(/^\(SELECT /);
      expect(p, p).toMatch(/\)$/);
      expect(balanced(p), `unbalanced parentheses in a proof: ${p}`).toBe(true);
      // Over the literal-blanked form: a quoted `[^;]` in a regex is not a
      // statement separator, and reading it as one would fail a sound proof.
      expect(blankLiterals(p), `a proof that is two statements: ${p}`).not.toMatch(/;\s*\S/);
    }
  });

  it('hides no proof from the anchored harvest, and records what the CI harvester over-reads', () => {
    // scripts/ci/check-migrations-are-live.mjs harvests with an UNANCHORED
    // regex, so the header sentence that introduces the proofs - "A `-- @live-
    // proof:` below is a parenthesised SELECT ..." - is harvested as a proof
    // too, and on a replay it would be put to psql as SQL inside the one UNION
    // ALL probe every proof shares. Two rules: nothing the CI harvester finds
    // beyond the anchored lines may be a real proof, and if it finds anything
    // extra at all, the changelog says so.
    const extras = (declaredProofs(SQL) as string[]).filter((p) => !PROOFS.includes(p));
    for (const e of extras) {
      expect(e, `a real proof sits outside the anchored harvest: ${e}`).not.toMatch(/^\(SELECT /);
    }
    if (extras.length > 0) {
      expect(CHANGELOG, 'the CI harvester over-reads this header and nobody wrote it down').toMatch(
        /`declaredProofs`/
      );
    }
  });

  it('carries prokind on every catalogue-wide pg_get_functiondef scan', () => {
    // n.nspname is a JOIN qual, so the planner pushes only the p.* quals into
    // the pg_proc scan and evaluates pg_get_functiondef over every row it
    // touches - aggregates included, for which it raises. A scan restricted to
    // a named allowlist is safe without it and is exempted by name.
    const units = [...PROOFS, CODE];
    let scans = 0;
    let guarded = 0;
    for (const u of units) {
      if (!u.includes('pg_get_functiondef(p.oid)')) continue;
      scans++;
      if (/p\.proname\s*(IN\s*\(|=\s*')/.test(u) && !/p\.proname\s*~/.test(u)) continue;
      expect(
        u,
        `a catalogue-wide pg_get_functiondef scan with no prokind filter: ${flat(u)}`
      ).toMatch(/p\.prokind\s*=\s*'f'/);
      guarded++;
    }
    expect(scans, 'nothing scans the catalogue, so this rule is vacuous').toBeGreaterThanOrEqual(5);
    expect(guarded, 'no unrestricted scan exists, so this rule is vacuous').toBeGreaterThanOrEqual(
      5
    );
  });

  it('proves the things a source test cannot, against the live catalogue', () => {
    const all = PROOFS.join('\n');
    for (const claim of [
      'fn_platform_frozen',
      'is_horse',
      'lightning_reservation_one_active_per_player',
      'lightning_pool_slot_one_open_per_player',
      'deadline_at',
      'participants_locked_at',
      'role_routine_grants',
      'has_function_privilege',
      'prosecdef',
      'relrowsecurity',
      'LIGHTNING_FORMATION_MOVED_MONEY',
    ]) {
      expect(all, `nothing is proved about ${claim} against the live database`).toContain(claim);
    }
  });
});
