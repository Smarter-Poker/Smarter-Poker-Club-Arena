/**
 * LIGHTNING 2.0 PHASE 9 REMEDIATION: NOTHING HOLDS A PLAYER THAT NOTHING CAN
 * RELEASE, THE LATCH IS NOT A BIRTHRIGHT, AND THE MONEY GUARD MEASURES THE
 * TRANSACTION IT IS IN.
 *
 * 20260926023047 repairs what an adversarial audit found in the applied
 * formation barrier 20260925215731: a reaper and an index that could not see a
 * dealing hand, a reaper nothing called, a latch a hand could be born with, a
 * money guard that measured other transactions, an exception list that let the
 * retryable classes through, TRUNCATE erasing every "immutable" row, and five
 * hand versions the specification requires and nothing recorded. Everything
 * below is a static reading of that ONE migration. The harness
 * `scripts/dev/test-lightning-phase9-formation.sh` proves the same claims
 * against a running catalogue; this file proves what a catalogue cannot see -
 * the transaction shape, which guard belongs to which statement, that every
 * body the file re-cuts is read back after it is installed, and that the words
 * a rule forbids are absent from CODE rather than merely from the prose around
 * it.
 *
 * THE RE-CUTS ARE CODE TOO. Six of the eight functions this file touches are
 * not written out: their installed bodies are read from the catalogue and
 * anchors are replaced with `$b$ ... $b$` literals that become the new body.
 * So every rule about code here - no is_horse, no money write, no definer - is
 * applied to those replacement texts as well as to the two functions the file
 * writes out, and the dollar-quote is transparent to the strip for exactly
 * that reason.
 *
 * THE STRIP. The same literal-aware scan as the formation suite: `code` loses
 * line comments, `biz` additionally blanks single-quoted literals to spaces of
 * the same length. This file's own assertions carry the forbidden words as
 * literals - `IF v_live ~ 'is_horse' THEN RAISE ... 'LAW 10.5 ...'` - so a rule
 * read over `code` would be broken by the very check that enforces it. Section
 * 2 asserts the scan is doing work on this file, in both directions.
 *
 * LIGHTNING_P9R_MIGRATION overrides the file under test, so mutation testing -
 * copying it to a scratch directory, breaking one line of the copy and watching
 * this suite go red - never touches the repository.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const FILE = '20260926023047_lightning_phase_9_remediation_nothing_holds_a_player_that_no.sql';
const MIGRATION = process.env.LIGHTNING_P9R_MIGRATION ?? path.join(MIGRATIONS, FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');

/**
 * One left-to-right scan producing both stripped forms at once, exactly as the
 * formation suite does it. A `--` inside a single-quoted literal is not a
 * comment, and a dollar-quote delimiter is transparent.
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
/** Signatures compared with the spacing taken out of the argument list. */
const sigKey = (s: string): string =>
  s
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim();

/** The functions this file WRITES OUT, discovered rather than listed. */
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
      .filter(Boolean)
      .join(', '),
    attrs: flat(m[3]),
    raw: m[5],
    body: s.code,
    biz: s.biz,
  };
});

/**
 * THE RE-CUTS, discovered: every top-level DO block that EXECUTEs a body it
 * built. Split on the raw text - not on CODE - because a `$b$` literal whose
 * closing tag follows a `--` on the same line loses that tag to the comment
 * strip, and the anchor/replacement boundary must not depend on it.
 */
const RECUTS = [...SQL.matchAll(/^DO (\$\w+\$)\n([\s\S]*?)\n\1;/gm)]
  .filter((m) => /^\s*EXECUTE v_new;/m.test(m[2]))
  .map((m) => {
    const raw = m[2];
    const target =
      /(?:v_fn\s+constant regprocedure|v_old\s+regprocedure)\s*:=\s*(?:to_regprocedure\()?'public\.(\w+)\(/.exec(
        raw
      );
    const aAt = raw.search(/^\s*a\s+text\[\]\s*:=\s*ARRAY\[/m);
    const bAt = raw.search(/^\s*b\s+text\[\]\s*:=\s*ARRAY\[/m);
    const beginAt = raw.search(/^BEGIN$/m);
    const s = scan(raw);
    return {
      tag: m[1],
      name: target ? target[1] : '',
      raw,
      anchors: aAt >= 0 && bAt > aAt ? raw.slice(aAt, bAt) : '',
      replacement: bAt >= 0 && beginAt > bAt ? raw.slice(bAt, beginAt) : '',
      logic: beginAt >= 0 ? scan(raw.slice(beginAt)).code : '',
      code: s.code,
      biz: s.biz,
    };
  });

const recutOf = (name: string) => {
  const r = RECUTS.find((x) => x.name === name);
  if (!r) throw new Error(`the migration no longer re-cuts public.${name}`);
  return r;
};

const FORM = recutOf('fn_lightning_form_hand');
const REAP = recutOf('fn_lightning_reap_formations');
const KEEPALIVE = FUNCTIONS.find((f) => f.name === 'fn_lightning_instance_keepalive');

/** The seven lightning tables, read from the migrations that created them. */
const LIGHTNING_TABLES = [
  ...new Set(
    fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f < FILE)
      .flatMap((f) =>
        [
          ...fs
            .readFileSync(path.join(MIGRATIONS, f), 'utf8')
            .matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?public\.(lightning_\w+)/gm),
        ].map((m) => m[1])
      )
  ),
].sort();

/** The top-level DO blocks, as offsets into CODE. */
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

/** Every @live-proof, harvested by the CI check's own reader, and the raw lines. */
const PROOF_LINES = SQL.split('\n').filter((l) => /^-- @live-proof:/.test(l));
const PROOFS = declaredProofs(SQL) as string[];

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

// ===========================================================================
//  1. THE SHAPE OF THE CHANGE
// ===========================================================================

describe('Phase 9 remediation: one transaction, bounded waits, every guard on its own name', () => {
  it('is exactly one transaction', () => {
    // Counted over CODE: every plpgsql body and every DO block opens with a
    // bare BEGIN, and none of those is a transaction.
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE).not.toMatch(/^ROLLBACK;$/m);
    expect(CODE.indexOf('BEGIN;')).toBeLessThan(CODE.indexOf('ALTER TABLE'));
    expect(CODE.lastIndexOf('COMMIT;')).toBeGreaterThan(CODE.lastIndexOf('COMMENT ON FUNCTION'));
  });

  it('sets SET LOCAL lock_timeout inside the transaction, before the first DDL', () => {
    // This file ALTERs three lightning tables, replaces an index and re-cuts
    // fn_cash_clusters_tick_all, all of which the engine's pass holds locks on.
    // An ACCESS EXCLUSIVE request that waits makes every later reader wait
    // behind it. Unlike 20260925215731, this file is not applied yet, so there
    // is no disjunction here: the statement is present, or this is red.
    const begin = CODE.indexOf('BEGIN;');
    const at = CODE.search(/^SET LOCAL lock_timeout\s*=\s*'\d+m?s'\s*;/m);
    expect(at, 'there is no SET LOCAL lock_timeout in this migration').toBeGreaterThan(-1);
    expect(at, 'the lock timeout is set before the transaction opens').toBeGreaterThan(begin);
    const afterBegin = CODE.slice(begin + 'BEGIN;'.length);
    const firstDdl = afterBegin.search(
      /^(ALTER|CREATE|DROP|DO|REVOKE|GRANT|COMMENT|UPDATE|INSERT|DELETE|TRUNCATE)\b/m
    );
    expect(firstDdl, 'no DDL found after BEGIN, so this rule is vacuous').toBeGreaterThan(-1);
    expect(at, 'the lock timeout is set after DDL has already queued').toBeLessThan(
      begin + 'BEGIN;'.length + firstDdl
    );
    expect(count(CODE, /SET LOCAL lock_timeout/g)).toBe(1);
  });

  it('adds one column per ALTER TABLE, every one IF NOT EXISTS, and its index IF NOT EXISTS', () => {
    const alters = [...CODE.matchAll(/ALTER TABLE[\s\S]*?;/g)].map((m) => m[0]);
    expect(alters.length, 'the ALTER TABLE parser found nothing').toBeGreaterThanOrEqual(5);
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
    expect(count(CODE, /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/g)).toBeGreaterThanOrEqual(1);
    expect(CODE, 'an index without IF NOT EXISTS applies exactly once').not.toMatch(
      /CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/
    );
    expect(CODE, 'a DROP INDEX that fails on a second application').not.toMatch(
      /DROP INDEX (?!IF EXISTS)/
    );
  });

  it('guards EVERY ADD CONSTRAINT with an existence check on its own name and its own table', () => {
    const adds = [...CODE.matchAll(/ALTER TABLE public\.(\w+)\s+ADD CONSTRAINT (\w+)/g)];
    expect(adds.length, 'this migration has stopped adding constraints').toBeGreaterThanOrEqual(2);
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

  it('guards EVERY CREATE TRIGGER, the literal ones and the ones built by format()', () => {
    // CREATE TRIGGER has no OR REPLACE here, so it applies exactly once, and a
    // trigger guarded on the wrong table would be skipped on the right one.
    const literal = [
      ...CODE.matchAll(/CREATE TRIGGER (\w+)\s+(?:BEFORE|AFTER)[\s\S]*?\bON public\.(\w+)/g),
    ];
    const built = [
      ...CODE.matchAll(/EXECUTE format\('CREATE TRIGGER %I\b[^']*'\s*,\s*([^;]*?)\);/g),
    ];
    expect(
      literal.length,
      'the immutability trigger is no longer re-created'
    ).toBeGreaterThanOrEqual(1);
    expect(built.length, 'the TRUNCATE triggers are no longer created').toBeGreaterThanOrEqual(1);
    expect(count(CODE, /CREATE (?:OR REPLACE )?TRIGGER/g), 'a CREATE TRIGGER nothing parsed').toBe(
      literal.length + built.length
    );
    for (const t of literal) {
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
    for (const b of built) {
      const at = b.index ?? -1;
      expect(insideDo(at), 'a built CREATE TRIGGER is not inside a DO block').toBe(true);
      const g = guardBefore(at);
      expect(g, 'a built CREATE TRIGGER has no existence check in front of it').toMatch(
        /^IF NOT EXISTS \(SELECT 1 FROM pg_trigger/
      );
      expect(g, "the built trigger borrows another statement's guard").not.toMatch(/END IF;/);
      // The name the guard asks about is the name format() is handed, and the
      // table the guard asks on is the table format() is handed.
      const [nameExpr, tableExpr] = b[1].split(/,\s*(?=[^,]*$)/).map((s) => s.trim());
      expect(g, `the guard does not ask about ${nameExpr}`).toContain(`tgname = ${nameExpr}`);
      expect(g, `the guard does not ask on ${tableExpr}`).toContain(
        `tgrelid = format('public.%I', ${tableExpr})::regclass`
      );
    }
  });
});

// ===========================================================================
//  2. THE STRIPS ARE PROVEN TO BE DOING WORK, IN BOTH DIRECTIONS
// ===========================================================================

describe('Phase 9 remediation: comments and literals are blanked, and the blanking is load-bearing', () => {
  it('removes real comments and blanks real literals without touching real code', () => {
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
    // The dollar-quote is transparent: a replacement body is code.
    expect(scan('$b$ UPDATE public.wallets SET x = 1; $b$').biz).toMatch(MONEY_WRITE);
  });

  it('is doing work on this migration in both directions, measured rather than assumed', () => {
    // THE COMMENT STRIP. The header argues Law 10.5 in prose; stripped, that
    // prose is gone.
    expect(count(SQL, /\bis_horse\b/g)).toBeGreaterThan(count(CODE, /\bis_horse\b/g));
    // THE LITERAL BLANK. The re-cut checks refuse is_horse by matching the
    // live body against the LITERAL 'is_horse' and raising a LITERAL message.
    // CODE carries those; BIZ must not, or the rule below would be broken by
    // the very check that enforces it.
    expect(CODE, 'no re-cut check names is_horse in a literal any more').toMatch(
      /IF v_live ~ 'is_horse' THEN/
    );
    expect(count(CODE, /\bis_horse\b/g)).toBeGreaterThan(0);
    expect(count(BIZ, /\bis_horse\b/g)).toBe(0);
    // And the retryable-class rule: the barrier's re-cut refuses query_canceled
    // by naming it in a literal, which BIZ blanks.
    expect(CODE).toMatch(/'query_canceled\|57014'/);
    expect(BIZ).not.toMatch(/query_canceled|57014/);
  });
});

// ===========================================================================
//  3. SERVICE_ROLE ONLY, INVOKER ONLY, DRIVEN OFF A REGEX
// ===========================================================================

describe('Phase 9 remediation: every new function object is revoked, granted to service_role, and an invoker', () => {
  /**
   * The objects that need a pair: every function written out, and every re-cut
   * that lands in a NEW signature - CREATE OR REPLACE with a different argument
   * list creates a new pg_proc row with default privileges, where a re-cut into
   * the same signature keeps the ACL it had.
   */
  const NEEDS_PAIR = [
    ...FUNCTIONS.map((f) => `public.${f.name}(${f.argTypes})`),
    ...RECUTS.flatMap((r) =>
      [
        ...r.raw.matchAll(
          /v_sig\s+regprocedure\s*:=\s*to_regprocedure\('(public\.\w+\([^)]*\))'\)/g
        ),
      ].map((m) => m[1])
    ),
  ];

  it('revokes and grants EVERY one of them, counted from both ends', () => {
    expect(FUNCTIONS.length, 'the function parser found nothing to check').toBeGreaterThanOrEqual(
      2
    );
    expect(NEEDS_PAIR.length).toBeGreaterThanOrEqual(3);
    expect(count(CODE, /^CREATE OR REPLACE FUNCTION/gm)).toBe(FUNCTIONS.length);
    const revokes = [
      ...CODE.matchAll(
        /^REVOKE ALL ON FUNCTION (public\.\w+\([^)]*\)) FROM PUBLIC, anon, authenticated;$/gm
      ),
    ].map((m) => sigKey(m[1]));
    const grants = [
      ...CODE.matchAll(/^GRANT EXECUTE ON FUNCTION (public\.\w+\([^)]*\)) TO service_role;$/gm),
    ].map((m) => sigKey(m[1]));
    for (const sig of NEEDS_PAIR) {
      expect(revokes, `${sig} is not revoked from the browser roles`).toContain(sigKey(sig));
      expect(grants, `${sig} is not granted to service_role`).toContain(sigKey(sig));
    }
    expect(count(CODE, /^REVOKE ALL ON FUNCTION /gm)).toBe(NEEDS_PAIR.length);
    expect(count(CODE, /^GRANT EXECUTE ON FUNCTION /gm)).toBe(NEEDS_PAIR.length);
    expect(BIZ, 'something in this file grants a browser role').not.toMatch(
      /GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i
    );
  });

  it('makes nothing SECURITY DEFINER unless the file argues for it, and pins every search_path', () => {
    for (const f of FUNCTIONS) {
      expect(f.attrs, `${f.name} does not pin its search_path`).toContain(
        "SET search_path TO 'public', 'pg_temp'"
      );
    }
    // Over BIZ, so the replacement bodies of the re-cuts are covered too, and
    // a sentence ABOUT definers in a literal is not one.
    const definers = [...BIZ.matchAll(/\bSECURITY DEFINER\b/g)].length;
    if (definers > 0) {
      expect(SQL, 'a SECURITY DEFINER that nothing in the file argues for').toMatch(
        /\bis SECURITY DEFINER because\b/
      );
    }
    for (const f of FUNCTIONS) {
      if (/SECURITY DEFINER/.test(f.attrs)) {
        expect(SQL, `${f.name} is a definer and nothing in the file argues why`).toMatch(
          new RegExp(`${f.name}[^\\n]*\\bis SECURITY DEFINER because\\b`)
        );
      }
    }
    // Non-vacuity: the file states the choice, and a proof asks the catalogue.
    expect(SQL).toMatch(/every new function SECURITY INVOKER/);
    expect(PROOFS.join('\n')).toMatch(/NOT p\.prosecdef/);
  });
});

// ===========================================================================
//  4. LAW 10.5 AND THE MONEY
// ===========================================================================

describe('Phase 9 remediation: a horse is a player, and nothing here moves money', () => {
  it('has no is_horse in any filtering position - written-out bodies and replacement bodies alike (Law 10.5)', () => {
    expect(BIZ, 'is_horse appears in code').not.toMatch(/\bis_horse\b/);
    for (const f of FUNCTIONS) {
      expect(f.biz, `${f.name} filters on is_horse`).not.toMatch(/\bis_horse\b/);
      expect(f.biz, `${f.name} reads a horse column`).not.toMatch(/\bhorse_id\b/);
    }
    for (const r of RECUTS) {
      expect(scan(r.replacement).biz, `the re-cut of ${r.name} filters on is_horse`).not.toMatch(
        /\bis_horse\b/
      );
    }
  });

  it('writes no seat, wallet, ledger or cash session - not in a function, a re-cut or the DDL', () => {
    for (const f of FUNCTIONS) {
      expect(f.biz, `${f.name} writes a money-bearing table`).not.toMatch(MONEY_WRITE);
    }
    for (const r of RECUTS) {
      expect(
        scan(r.replacement).biz,
        `the re-cut of ${r.name} writes a money-bearing table`
      ).not.toMatch(MONEY_WRITE);
    }
    expect(BIZ, 'something in this file writes a money-bearing table').not.toMatch(MONEY_WRITE);
    // Non-vacuity: the barrier's replacement READS the participants' pool
    // sessions, before and after, under FOR SHARE.
    const form = scan(FORM.replacement).code;
    expect(count(form, /FROM public\.lightning_pool_session ps/g)).toBeGreaterThanOrEqual(2);
    expect(form).toMatch(/FOR SHARE/);
    expect(form).toContain('IF v_money_after IS DISTINCT FROM v_money_before THEN');
  });
});

// ===========================================================================
//  5. WHAT THE REMEDIATION REPAIRS
// ===========================================================================

describe('Phase 9 remediation: the repairs are the ones the header claims', () => {
  it('reaps all four live instance states, and the index it reads covers the same four', () => {
    const FOUR = "IN ('forming', 'reserved', 'dealing', 'settling')";
    const repl = scan(REAP.replacement).code;
    expect(flat(repl), 'the reaper replacement does not filter the four live states').toContain(
      `li.state ${FOUR}`
    );
    expect(repl, 'the two-state filter survives in the replacement').not.toMatch(
      /IN \('forming', 'reserved'\)/
    );
    // It is the two-state filter that is REPLACED, not something next to it.
    expect(REAP.anchors).toMatch(/WHERE li\.state IN \('forming', 'reserved'\)\$a\$/);
    // And the read-back asserts the four states are what got installed.
    expect(REAP.logic).toContain(
      `'li.state IN (''forming'', ''reserved'', ''dealing'', ''settling'')'`
    );
    // The index.
    expect(flat(CODE)).toContain(
      `CREATE INDEX IF NOT EXISTS lightning_instance_live_past_deadline ON public.lightning_instance (deadline_at) WHERE state ${FOUR};`
    );
    expect(CODE).toContain('DROP INDEX IF EXISTS public.lightning_instance_past_deadline;');
    // The heartbeat reaches the two states the old reaper could not.
    expect(KEEPALIVE, 'fn_lightning_instance_keepalive is no longer written out').toBeTruthy();
    expect(KEEPALIVE!.body).toContain("li.state IN ('dealing', 'settling')");
  });

  it('refuses TRUNCATE on all seven lightning tables by trigger, AND revokes it from service_role', () => {
    expect(
      LIGHTNING_TABLES,
      'the lightning tables were not found in their migrations'
    ).toHaveLength(7);
    const loops = [
      ...CODE.matchAll(/FOREACH (\w+) IN ARRAY ARRAY\[([^\]]*)\] LOOP([\s\S]*?)END LOOP;/g),
    ].filter((m) => /BEFORE TRUNCATE/.test(m[3]));
    expect(loops, 'there is not exactly one TRUNCATE loop').toHaveLength(1);
    const [, , list, loop] = loops[0];
    const named = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    expect(named, 'the TRUNCATE loop does not cover exactly the seven lightning tables').toEqual(
      LIGHTNING_TABLES
    );
    expect(loop).toMatch(
      /EXECUTE format\('CREATE TRIGGER %I BEFORE TRUNCATE ON public\.%I FOR EACH STATEMENT EXECUTE FUNCTION public\.fn_lightning_refuses_truncate\(\)'/
    );
    expect(loop, 'TRUNCATE is not revoked from service_role inside the same loop').toMatch(
      /EXECUTE format\('REVOKE TRUNCATE ON public\.%I FROM service_role\b/
    );
    // The function refuses; it never lets the statement through.
    const f = FUNCTIONS.find((x) => x.name === 'fn_lightning_refuses_truncate');
    expect(f, 'fn_lightning_refuses_truncate is no longer written out').toBeTruthy();
    expect(f!.body).toMatch(/RAISE EXCEPTION 'LIGHTNING_HISTORY_IS_NOT_TRUNCATABLE/);
    expect(f!.biz).not.toMatch(/\bRETURN\b/);
  });

  it("names the retryable SQLSTATEs in the barrier's handlers, and not query_canceled", () => {
    const repl = flat(scan(FORM.replacement).biz);
    // The atomic block: the closed list plus the three retryable classes.
    expect(repl).toMatch(
      /WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation OR exclusion_violation OR lock_not_available OR deadlock_detected OR serialization_failure THEN/
    );
    // The outer block, around every wait outside the atomic one: the same
    // three and only those three, answered formation_contended with a retry.
    expect(repl).toMatch(
      /EXCEPTION WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN GET STACKED DIAGNOSTICS/
    );
    expect(scan(FORM.replacement).code).toContain("'lightning_matcher_retry'");
    expect(scan(FORM.replacement).code).toContain("'formation_contended'");
    expect(repl).not.toMatch(/\bquery_canceled\b|\b57014\b/);
    expect(repl, 'a WHEN OTHERS would swallow a cancel').not.toMatch(/WHEN OTHERS/);
  });

  it('adds the five version columns the specification names, NOT NULL, and names them in a CHECK', () => {
    const cols = [
      'rules_version',
      'matcher_version',
      'blind_algorithm_version',
      'lightning_version',
      'rake_version',
    ];
    const check = /ADD CONSTRAINT lightning_hand_versions_are_named\s+CHECK \(([\s\S]*?)\);/.exec(
      CODE
    );
    expect(check, 'the versions CHECK is gone').toBeTruthy();
    for (const c of cols) {
      expect(CODE, `${c} is not added`).toContain(
        `ALTER TABLE public.lightning_hand ADD COLUMN IF NOT EXISTS ${c} text;`
      );
      expect(CODE, `${c} is not made NOT NULL`).toContain(
        `ALTER TABLE public.lightning_hand ALTER COLUMN ${c} SET NOT NULL;`
      );
      expect(check![1], `${c} is not named IS NOT NULL in the CHECK`).toContain(
        `${c} IS NOT NULL AND length(btrim(${c})) > 0`
      );
    }
    // The barrier stamps all five in the INSERT that creates the hand.
    expect(flat(scan(FORM.replacement).code)).toContain(
      'rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version)'
    );
  });

  it('reads back from pg_get_functiondef after EVERY EXECUTE of a re-cut, and counts every anchor first', () => {
    expect(RECUTS.length, 'the re-cut parser found nothing').toBeGreaterThanOrEqual(6);
    for (const r of RECUTS) {
      expect(r.name, `a re-cut block ${r.tag} whose target the parser could not name`).not.toBe('');
      const logic = r.logic;
      const exec = logic.lastIndexOf('EXECUTE v_new;');
      expect(exec, `${r.name}: no EXECUTE in the re-cut`).toBeGreaterThan(-1);
      // Counted to exactly one, and refused otherwise, before anything runs.
      const counted = logic.search(/IF v_n <> 1 THEN\s+RAISE EXCEPTION/);
      expect(counted, `${r.name}: an anchor is replaced without being counted`).toBeGreaterThan(-1);
      expect(counted, `${r.name}: the anchors are counted after the EXECUTE`).toBeLessThan(exec);
      // Read back from the catalogue, after the EXECUTE, from the function
      // the block re-cut, and then asserted on.
      const readBack = logic.slice(exec).search(/v_live := pg_get_functiondef\((v_fn|v_sig)\);/);
      expect(
        readBack,
        `${r.name}: nothing reads the body back after it is installed`
      ).toBeGreaterThan(-1);
      const after = logic.slice(exec + readBack);
      expect(after, `${r.name}: the read-back is never asserted on`).toMatch(
        /(position\([^)]*\bin v_live\)|v_live ~)[\s\S]*?RAISE EXCEPTION/
      );
    }
  });
});

// ===========================================================================
//  6. THE PROOFS
// ===========================================================================

describe('Phase 9 remediation: it proves what it says, and its catalogue scans can run', () => {
  it('declares live proofs, every one a balanced parenthesised SELECT, as a floor', () => {
    // A FLOOR, NEVER AN EQUALITY - a count written in prose goes stale. What IS
    // exact is that the CI reader and the raw lines agree.
    expect(PROOFS.length, 'the CI harvester and the raw lines disagree').toBe(PROOF_LINES.length);
    expect(PROOFS.length, 'the file has stopped proving things').toBeGreaterThanOrEqual(30);
    for (const p of PROOFS) {
      expect(p, p).toMatch(/^\(SELECT /);
      expect(p, p).toMatch(/\)$/);
      expect(balanced(p), `unbalanced parentheses in a proof: ${p}`).toBe(true);
      expect(blankLiterals(p), `a proof that is two statements: ${p}`).not.toMatch(/;\s*\S/);
    }
    // The header's own sentence about the convention quotes the marker, and is
    // not harvested - the defect this reader was fixed for.
    expect(
      SQL.split('\n').some((l) => l.includes('@live-proof:') && !/^-- @live-proof: /.test(l))
    ).toBe(true);
    expect(PROOFS.filter((p) => p.startsWith('`'))).toEqual([]);
    // And the anchor cuts the other way too: a proof that is indented, or
    // spaced differently, is invisible to the harness and to the CI check
    // alike, and would sit in the file proving nothing.
    const hidden = SQL.split('\n').filter(
      (l) => /@live-proof:\s*\(SELECT/.test(l) && !/^-- @live-proof: /.test(l)
    );
    expect(hidden, 'a proof the anchored harvest cannot see').toEqual([]);
  });

  it('carries prokind on every catalogue-wide pg_get_functiondef scan', () => {
    // n.nspname is a JOIN qual, so the planner pushes only the p.* quals into
    // the pg_proc scan and pg_get_functiondef runs over every row it touches -
    // aggregates included, for which it raises. A scan restricted to a named
    // allowlist is safe without it and is exempted.
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
      4
    );
  });

  it('proves the repairs against the live catalogue, not only against this text', () => {
    const all = PROOFS.join('\n');
    for (const claim of [
      'fn_lightning_refuses_truncate',
      'TRUNCATE',
      "'dealing'",
      "'settling'",
      'fn_lightning_instance_keepalive',
      'LIGHTNING_HAND_IS_BORN_UNLOCKED',
      'LIGHTNING_INSTANCE_HAND_SET_DOES_NOT_AGREE',
      'serialization_failure',
      'rake_version',
      'is_horse',
      'FOR SHARE',
      'role_routine_grants',
    ]) {
      expect(all, `nothing is proved about ${claim} against the live database`).toContain(claim);
    }
  });
});
