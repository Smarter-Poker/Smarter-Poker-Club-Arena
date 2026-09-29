/**
 * A SPIN IS DRAWN, STAMPED AND BOOKED BY THE LAUNCH THAT DEALS IT
 * (2026-09-22, BINDING)
 *
 * Owner policy v2.9 (Dan, 2026-09-22): "hard code fixing it at its root cause,
 * then hardening it to prevent it from ever breaking or regressing again", and
 * "never add or rely on a cron, watcher, reconciler or repair loop to
 * compensate for a defect."
 *
 * Three Spin pg_cron jobs existed only to mend a state some writer used to
 * leave behind:
 *
 *   spin_repair_missing_multiplier      a RUNNING or COMPLETED Spin whose row
 *                                       carries no drawn multiplier
 *   spin_sweep_unbooked                 a Spin with a multiplier on its row and
 *                                       no reserve booking behind it
 *   ca-spin-return-unawarded-draws-15m  a finished Spin whose escrow kept part
 *                                       of the prize it drew from the reserve
 *
 * MEASURED 2026-09-22 on production, read-only. Every candidate set is empty
 * at any age. The multiplier repair last changed a row on 2026-09-06 12:45
 * UTC. No reserve booking outside the atomic draw exists after 2026-09-08
 * 06:03:25 UTC (no contribution row carrying a multiplier, no rake row from
 * fn_spin_settle_game), and all 37,391 draws booked from 2026-09-10 03:52 UTC
 * to 2026-09-22 14:17 UTC carry their immutable draw receipt. The
 * unawarded-draw return changed nothing in 1,268 scheduled runs; its only two
 * rows were written by the migrations that shipped it.
 *
 * The writers were fixed at the source between 2026-09-08 and 2026-09-10, and
 * this law pins each fix where production runs it:
 *
 *   1. fn_spin_draw_and_settle_atomic books the entry, draws, settles, writes
 *      the receipt and stamps the tournament row in ONE transaction. After the
 *      entry is booked every refusal RAISES, so nothing half-done commits.
 *   2. fn_complete_tournament_launch_before_lease_generation is the only
 *      writer of RUNNING, and refuses a paid Spin without exactly one
 *      jackpot_draw equal to a positive multiplier on its row. The engine has
 *      no other door, and its presentation write never carries the contract.
 *   3. spin_tournament_contract_is_draw refuses any multiplier or prize that is
 *      not the one reserve draw, and the reserve rows it compares against can
 *      be neither updated nor deleted.
 *   4. A Spin is created undrawn, and a drawn Spin is never expired.
 *
 * WHERE PRODUCTION RUNS IT means the LAST migration that declares a function
 * in CODE. Comments are removed first, nested ones included:
 * 20260910034412 keeps its rollback - the original, defective body - inside a
 * block comment BELOW the real declaration, so the last occurrence in raw text
 * is the defect this law exists to keep out.
 *
 * NOT PINNED HERE, VERIFIED LIVE 2026-09-22: atomic_cancel_tournament refuses
 * to cancel a Spin that has a jackpot_draw or a draw receipt (installed by
 * 20260910171843), and the terminal settlement closes the prize, bounty and
 * fee escrow at exactly zero before COMPLETED. Both live bodies are composed
 * from textual patches, so no migration file holds the text production runs;
 * a file pin there would read as armed while guarding a stale copy.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { migrationCorpus } from './helpers/migrationCorpus';
import {
  blankNonCode,
  sliceMethod,
  sliceSqlStatement,
  sliceStatement,
} from './helpers/sourceWindow';

/**
 * SQL with every comment removed, nested block comments included.
 *
 * AND WITH DOLLAR-QUOTED DATA REMOVED (2026-09-23, issue #5008). A dollar-quoted
 * block that is NOT a function body, an anonymous block or plpgsql dynamic SQL
 * is a value being passed to something, and a value is not a statement.
 * 20260917060339_spin_expiry_lock_order.sql pins the expected definition of
 * every spin trigger inside one `$trigger_pins$[...]$trigger_pins$` JSON
 * literal it hands to `jsonb_array_elements()` - so that it can ASSERT those
 * triggers are present and unchanged. Reading that blob as code made
 * `lastTriggerStatement` return a JSON-escaped copy of the definition rather
 * than the last real CREATE TRIGGER, and this law went red at a migration that
 * agrees with it. A block after AS, DO or EXECUTE is still scanned in full, so
 * a real CREATE TRIGGER still has nowhere to hide.
 */
function sqlCode(sql: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '/' && d === '*') {
      depth++;
      i++;
      continue;
    }
    if (depth > 0) {
      if (c === '*' && d === '/') {
        depth--;
        i++;
      }
      continue;
    }
    if (c === '-' && d === '-') {
      const eol = sql.indexOf('\n', i);
      if (eol < 0) break;
      i = eol - 1;
      continue;
    }
    if (c === '$' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i))?.[0];
      const end = tag ? sql.indexOf(tag, i + tag.length) : -1;
      if (tag && end >= 0) {
        // The whole block is consumed in ONE step, opening tag to closing tag.
        // Stepping into it character by character would meet the CLOSING tag as
        // if it were an opening one and swallow everything up to the next
        // function's body.
        const body = sql.slice(i + tag.length, end);
        const executable = /\b(?:AS|EXECUTE|DO(?:\s+LANGUAGE\s+\w+)?)\s*$/i.test(out);
        out += executable ? tag + sqlCode(body) + tag : ' ';
        i = end + tag.length - 1;
        continue;
      }
    }
    out += c;
  }
  return out;
}

const codeCache = new Map<string, string>();
function codeOf(name: string, sql: string): string {
  const hit = codeCache.get(name);
  if (hit !== undefined) return hit;
  const code = sqlCode(sql);
  codeCache.set(name, code);
  return code;
}

interface Declared {
  file: string;
  body: string;
}

/** The body production runs: the last migration that declares `fn` in code. */
function declared(fn: string): Declared {
  const header = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.${fn}\s*\(`,
    'gi'
  );
  let found: Declared | null = null;
  for (const migration of migrationCorpus()) {
    if (!migration.sql.includes(`public.${fn}`)) continue;
    const code = codeOf(migration.name, migration.sql);
    const heads = [...code.matchAll(header)];
    if (heads.length === 0) continue;
    const tail = code.slice(heads[heads.length - 1].index ?? 0);
    const open = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(tail);
    if (!open) throw new Error(`${fn} in ${migration.name} has no dollar-quoted body`);
    const start = open.index + open[0].length;
    const end = tail.indexOf(open[1], start);
    if (end < 0) throw new Error(`${fn} in ${migration.name} never closes ${open[1]}`);
    found = { file: migration.name, body: tail.slice(start, end) };
  }
  if (!found) throw new Error(`no migration declares public.${fn} in code`);
  return found;
}

/**
 * The last CREATE, DROP, ENABLE or DISABLE of `trigger` in code. A trigger is
 * armed only while the last word any migration said about it is its CREATE.
 */
function lastTriggerStatement(trigger: string): { file: string; statement: string } {
  const statement = new RegExp(
    String.raw`(?:CREATE\s+TRIGGER|DROP\s+TRIGGER(?:\s+IF\s+EXISTS)?|(?:ENABLE|DISABLE)\s+TRIGGER)\s+${trigger}\b[^;]*;`,
    'gi'
  );
  let last: { file: string; statement: string } | null = null;
  for (const migration of migrationCorpus()) {
    if (!migration.sql.includes(trigger)) continue;
    for (const hit of codeOf(migration.name, migration.sql).matchAll(statement)) {
      last = { file: migration.name, statement: hit[0] };
    }
  }
  if (!last) throw new Error(`no migration names trigger ${trigger} in code`);
  return last;
}

function indexOfPattern(src: string, pattern: RegExp): number {
  const at = src.search(pattern);
  expect(at, `expected ${pattern} in the declared body`).toBeGreaterThan(-1);
  return at;
}

const DRAW = declared('fn_spin_draw_and_settle_atomic').body;
const LAUNCH = declared('fn_complete_tournament_launch_before_lease_generation').body;
const CONTRACT = declared('fn_spin_tournament_contract_is_draw').body;
const RECEIPT = declared('fn_spin_reserve_receipt_is_immutable').body;
const CREATE = declared('fn_create_seat_first_game_atomic').body;
const EXPIRE = declared('fn_spin_expire_unfilled').body;

describe('the draw, the booking and the stamp commit together', () => {
  it('reads a zero multiplier as undrawn and refuses only a positive projection', () => {
    expect(DRAW).toMatch(
      /IF\s+COALESCE\(v_t\.spin_multiplier,\s*0\)\s*>\s*0\s+THEN\s+RETURN\s+jsonb_build_object\(\s*'ok',\s*false,\s*'reason',\s*'projected_spin_draw_has_no_funding_proof'\s*\)/
    );
    // The D1 gate that parked 106 paid Spins for a night on 2026-09-10.
    expect(DRAW).not.toMatch(/v_t\.spin_multiplier\s+IS\s+NOT\s+NULL/i);
  });

  it('books, draws, settles, writes the receipt and stamps the row, in that order', () => {
    const book = indexOfPattern(
      DRAW,
      /v_entry\s*:=\s*public\.fn_spin_book_entry\(\s*p_tournament_id\s*\)/
    );
    const draw = indexOfPattern(DRAW, /v_draw\s*:=\s*public\.fn_spin_draw_multiplier\(/);
    const settle = indexOfPattern(
      DRAW,
      /v_settle\s*:=\s*public\.fn_spin_settle_game\(\s*p_tournament_id\s*,/
    );
    const receipt = indexOfPattern(DRAW, /INSERT\s+INTO\s+public\.spin_draw_receipts\s*\(/);
    const stamp = indexOfPattern(
      DRAW,
      /UPDATE\s+public\.tournaments\s+SET\s+spin_multiplier\s*=\s*v_multiplier\s*,\s*prize_pool\s*=\s*v_prize\s*,\s*spin_locked_tiers\s*=\s*v_locked/
    );
    const readBack = indexOfPattern(DRAW, /GET\s+DIAGNOSTICS\s+v_stamped\s*=\s*ROW_COUNT/);
    expect(book).toBeLessThan(draw);
    expect(draw).toBeLessThan(settle);
    expect(settle).toBeLessThan(receipt);
    expect(receipt).toBeLessThan(stamp);
    expect(stamp).toBeLessThan(readBack);
  });

  it('once the entry is booked, a refusal can only roll back', () => {
    const afterBooking = DRAW.slice(
      indexOfPattern(DRAW, /v_entry\s*:=\s*public\.fn_spin_book_entry\(/)
    );
    // A soft refusal here would commit a booked entry with no draw, or a draw
    // with no stamp: exactly the two states the retired jobs used to mend.
    expect(afterBooking).not.toMatch(/RETURN\s+jsonb_build_object\(\s*'ok'\s*,\s*false/i);
    for (const refusal of [
      /IF\s+NOT\s+COALESCE\(\(v_entry->>'ok'\)::boolean,\s*false\)\s+THEN\s+RAISE\s+EXCEPTION/,
      /IF\s+NOT\s+COALESCE\(\(v_draw->>'ok'\)::boolean,\s*false\)\s+THEN\s+RAISE\s+EXCEPTION/,
      /RAISE\s+EXCEPTION\s+'Spin settlement does not prove the selected funded prize/,
      /RAISE\s+EXCEPTION\s+'Spin % tournament contract did not read back exactly'/,
    ]) {
      expect(afterBooking).toMatch(refusal);
    }
  });

  it('the stamp is read back exactly, or the whole launch transaction rolls back', () => {
    const readBack = DRAW.slice(
      indexOfPattern(DRAW, /GET\s+DIAGNOSTICS\s+v_stamped\s*=\s*ROW_COUNT/)
    );
    expect(readBack).toMatch(/IF\s+v_stamped\s*<>\s*1\s+OR\s+NOT\s+EXISTS\s*\(/);
    expect(readBack).toMatch(/t\.spin_multiplier\s+IS\s+NOT\s+DISTINCT\s+FROM\s+v_multiplier/);
    expect(readBack).toMatch(/t\.prize_pool\s+IS\s+NOT\s+DISTINCT\s+FROM\s+v_prize/);
    expect(readBack).toMatch(/t\.spin_locked_tiers\s+IS\s+NOT\s+DISTINCT\s+FROM\s+v_locked/);
  });

  it('a draw booked before the cutover launches only on a row already stamped with it', () => {
    expect(DRAW).toMatch(/v_multiplier\s+IS\s+DISTINCT\s+FROM\s+v_t\.spin_multiplier/);
    expect(DRAW).toMatch(/COALESCE\(v_multiplier,\s*0\)\s*<=\s*0/);
    expect(DRAW).toContain("'legacy_spin_rules_unproven'");
  });
});

describe('RUNNING is refused to a paid Spin that has not drawn and stamped', () => {
  it('names every paid Spin, by variant or by type', () => {
    expect(LAUNCH).toMatch(
      /\(\(lower\(COALESCE\(t\.variant,\s*''\)\)\s*=\s*'spin'\s+OR\s+upper\(COALESCE\(t\.tournament_type,\s*''\)\)\s*=\s*'SPIN'\)\s+AND\s+COALESCE\(t\.buy_in_amount,\s*0\)\s*>\s*0\)/
    );
  });

  it('requires exactly one jackpot_draw equal to a positive multiplier on the row', () => {
    expect(LAUNCH).toMatch(
      /IF\s+v_is_paid_spin\s+THEN\s+SELECT\s+count\(\*\),\s*min\(l\.multiplier\)\s+INTO\s+v_spin_ledger_count,\s*v_spin_ledger_multiplier\s+FROM\s+public\.spin_reserve_ledger\s+l\s+WHERE\s+l\.tournament_id\s*=\s*p_tournament_id\s+AND\s+l\.kind\s*=\s*'jackpot_draw'/
    );
    expect(LAUNCH).toMatch(
      /IF\s+v_spin_ledger_count\s*<>\s*1\s+OR\s+COALESCE\(v_spin_multiplier,\s*0\)\s*<=\s*0\s+OR\s+v_spin_ledger_multiplier\s+IS\s+DISTINCT\s+FROM\s+v_spin_multiplier\s+THEN\s+RETURN\s+jsonb_build_object\(\s*'ok',\s*false,\s*'reason',\s*'launch_spin_settlement_unproven'/
    );
  });

  it('asks before it writes RUNNING, and writes it exactly once', () => {
    const gate = indexOfPattern(LAUNCH, /'launch_spin_settlement_unproven'/);
    const running = indexOfPattern(
      LAUNCH,
      /UPDATE\s+public\.tournaments\s+SET\s+status\s*=\s*'RUNNING'/
    );
    expect(running).toBeGreaterThan(gate);
    expect(LAUNCH.match(/SET\s+status\s*=\s*'RUNNING'/gi) ?? []).toHaveLength(1);
  });
});

const SERVER_SRC = resolve(__dirname, '..', 'server', 'src');
const NOT_RUNTIME = new Set(['__fixtures__', '__mocks__', '__tests__']);

function runtimeSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!NOT_RUNTIME.has(entry)) runtimeSources(full, out);
    } else if (full.endsWith('.ts') && !/\.test\.ts$/.test(full)) {
      out.push(full);
    }
  }
  return out;
}

/** TypeScript with comments removed and string literals kept: 'RUNNING' is the point. */
const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('the engine has no other door to RUNNING, and never writes the contract', () => {
  const base = readFileSync(join(SERVER_SRC, 'tournament', 'TournamentManagerBase.ts'), 'utf8');

  it('finds the engine sources', () => {
    expect(runtimeSources(SERVER_SRC).length).toBeGreaterThan(20);
  });

  it('no engine source writes status RUNNING itself', () => {
    const offenders = runtimeSources(SERVER_SRC)
      .filter((file) =>
        /\bstatus\s*:\s*['"`]RUNNING['"`]/.test(withoutComments(readFileSync(file, 'utf8')))
      )
      .map((file) => file.replace(SERVER_SRC, 'server/src'));
    expect(offenders).toEqual([]);
  });

  it('the launch reaches RUNNING only through the completion that proves the draw', () => {
    const complete = sliceMethod(base, 'private async completeTournamentLaunch(');
    expect(complete).toContain("supabase.rpc('fn_complete_tournament_launch_atomic'");
  });

  it('the write after the draw is presentation only', () => {
    // Blank comments and strings: the object's own comment names is_premium_spin
    // to explain why it is absent, and that sentence is not a key.
    const patch = blankNonCode(sliceStatement(base, 'const spinPresentationPatch = {'));
    for (const key of ['spin_multiplier', 'prize_pool', 'spin_locked_tiers', 'is_premium_spin']) {
      expect(patch, key).not.toMatch(new RegExp(String.raw`\b${key}\s*:`));
    }
  });
});

describe('a drawn multiplier is the one immutable reserve draw, or nothing', () => {
  it('refuses any multiplier or prize that is not the one jackpot_draw', () => {
    expect(CONTRACT).toMatch(/r\.kind\s*=\s*'jackpot_draw'/);
    expect(CONTRACT).toMatch(
      /IF\s+v_count\s*<>\s*1\s+OR\s+NEW\.spin_multiplier\s+IS\s+DISTINCT\s+FROM\s+v_multiplier\s+OR\s+NEW\.prize_pool\s+IS\s+DISTINCT\s+FROM\s+v_prize\s+THEN\s+RAISE\s+EXCEPTION/
    );
  });

  it('neither of its two doors lets a multiplier appear or vanish', () => {
    // Cancellation keeps the multiplier it had; the pre-launch door is zero
    // on both sides.
    expect(CONTRACT).toMatch(
      /NEW\.spin_multiplier\s+IS\s+NOT\s+DISTINCT\s+FROM\s+OLD\.spin_multiplier/
    );
    expect(CONTRACT).toMatch(/COALESCE\(OLD\.spin_multiplier,\s*0\)\s*=\s*0/);
    expect(CONTRACT).toMatch(/COALESCE\(NEW\.spin_multiplier,\s*0\)\s*=\s*0/);
  });

  it('watches every contract column, and nothing has disarmed it since', () => {
    const last = lastTriggerStatement('spin_tournament_contract_is_draw');
    expect(last.statement, last.file).toMatch(
      /^CREATE\s+TRIGGER\s+spin_tournament_contract_is_draw\s+BEFORE\s+UPDATE\s+OF\s+spin_multiplier\s*,\s*prize_pool\s*,\s*spin_locked_tiers\s+ON\s+public\.tournaments\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+FUNCTION\s+public\.fn_spin_tournament_contract_is_draw\(\)/i
    );
  });

  it('a contribution or a jackpot_draw, once written, can be neither changed nor removed', () => {
    const kinds = /IF\s+OLD\.kind\s+IN\s*\(([^)]*)\)\s*THEN\s+RAISE\s+EXCEPTION/i.exec(RECEIPT);
    expect(kinds, 'the reserve receipt guard no longer refuses by kind').not.toBeNull();
    expect(kinds![1]).toContain("'contribution'");
    expect(kinds![1]).toContain("'jackpot_draw'");
    const last = lastTriggerStatement('spin_reserve_receipt_is_immutable');
    expect(last.statement, last.file).toMatch(
      /^CREATE\s+TRIGGER\s+spin_reserve_receipt_is_immutable\s+BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+public\.spin_reserve_ledger\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+FUNCTION\s+public\.fn_spin_reserve_receipt_is_immutable\(\)/i
    );
  });
});

describe('a Spin is born undrawn, and a drawn Spin is never expired', () => {
  it('the seat-first creator refuses a multiplier and any status but REGISTERING', () => {
    const validation = CREATE.slice(
      indexOfPattern(CREATE, /IF\s+v_club_id\s+IS\s+NULL/),
      indexOfPattern(CREATE, /RAISE\s+EXCEPTION\s+'SEAT_FIRST_CREATE_INVALID_CONFIG'/)
    );
    expect(validation).toMatch(
      /OR\s+NULLIF\(p_config->>'spin_multiplier',\s*''\)\s+IS\s+NOT\s+NULL/
    );
    expect(validation).toMatch(/OR\s+v_requested_status\s*<>\s*'REGISTERING'/);
    const insert = sliceSqlStatement(CREATE, 'INSERT INTO public.tournaments');
    expect(insert).not.toMatch(/spin_multiplier/);
    expect(insert).toContain("'REGISTERING'");
  });

  it('the unfilled expiry skips a Spin that has drawn, by its row or by its receipt', () => {
    expect(EXPIRE).toMatch(
      /l\.kind\s*=\s*'jackpot_draw'\s*\)\s*OR\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.spin_draw_receipts/
    );
    expect(EXPIRE).toMatch(
      /OR\s+COALESCE\(v_current\.spin_multiplier,\s*0\)\s*>\s*0\s+OR\s+v_current\.has_booked_draw\s+THEN\s+v_skipped\s*:=\s*v_skipped\s*\+\s*1;\s*CONTINUE;/
    );
  });
});
