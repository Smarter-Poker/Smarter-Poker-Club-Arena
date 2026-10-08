/**
 * ===========================================================================
 *  THE JOURNAL EXPLAINS THE BALANCE
 * ===========================================================================
 *
 * A player's diamond balance and the ledger that explains it are written by
 * the same hand, in the same transaction, or not at all.
 *
 * WHY THIS EXISTS (2026-09-30). 439 wallets held 220,985 diamonds that
 * diamond_transactions could not account for. The balance was always HIGH,
 * never low, so no player was ever short - but a third of the wallets with a
 * ledger showed the player two numbers on one screen that could not both be
 * true, because fn_diamond_wallet_summary reads on_hand from
 * profiles.diamonds and lifetime_earned/lifetime_spent from the journal.
 *
 * THE CAUSE, named to the line: before 2026-09-01 handle_new_user's
 * `INSERT INTO public.profiles (... diamonds ...) VALUES (... 500 ...)`
 * carried the 500 diamond welcome grant as a literal in the profiles row. The
 * balance existed from the instant the row was born and no journal row was
 * ever written for it. The newest affected profile was born 2026-09-01
 * 01:46:08 UTC; migration 20260901032430 landed at 03:24:30 UTC the same
 * morning and the drift stops dead there.
 *
 * THE CAUSE IS CLOSED, THREE TIMES OVER, and this law is what stops it being
 * quietly reopened:
 *   20260901032430  the signup grant journals itself;
 *   2026-09-08      handle_new_user inserts 0 and asks fn_ca_mint for the 500
 *                   under op id signup:<id>, which fills the balance,
 *                   journals it and registers it in one call;
 *   2026-09-15      ca_diamond_rule_modes flipped DR2 and DR6 from 'log' to
 *                   'refuse'. DR2 (zz_ca_diamond_born_with_balance) refuses a
 *                   player profile INSERT that carries a balance. DR6
 *                   (zz_ca_audit_diamond_change) refuses an unsanctioned
 *                   write to profiles.diamonds.
 *
 * Those two rule rows and their two triggers ARE the hard-coded fix
 * (CLAUDE.md 10.11). A migration that sets either back to 'log', or drops or
 * disables either trigger, un-fixes the defect silently - the guards would
 * still read as present while refusing nothing, which is exactly the failure
 * mode CLAUDE.md 10.86 is about. So this law refuses all three moves, and
 * refuses a new born-with-balance door besides.
 *
 * The damage was settled by 20260930055147, which wrote the 439 missing
 * journal rows and changed no balance: the ledger was wrong and the wallets
 * were right, and nothing is taken back from a player for our defect
 * (CLAUDE.md 10.9 rule 3).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIG_DIR = join(ROOT, 'supabase/migrations');

/**
 * The first version this law binds. 20260930055147 is the settlement itself;
 * everything before it is history, including the born-with-balance door and
 * the three migrations that closed it.
 */
export const BINDS_FROM = '20260930000000';

type Migration = { version: string; file: string; sql: string };

/** Comments carry the reasoning and must never trip a code rule. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function boundMigrations(): Migration[] {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ version: (f.match(/^(\d{14})/) || [])[1] || '', file: f }))
    .filter((m) => m.version && m.version >= BINDS_FROM)
    .map((m) => ({
      ...m,
      sql: stripComments(readFileSync(join(MIG_DIR, m.file), 'utf8')),
    }));
}

describe('the journal explains the balance', () => {
  it('the migration directory is readable and the law has something to scan', () => {
    // A law that silently scans nothing is not a law (CLAUDE.md 10.86 rule 1:
    // "I could not tell" is a distinct outcome and must have its own name).
    const all = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
    expect(all.length).toBeGreaterThan(0);
  });

  it('no migration disarms DR2 or DR6 back to log or warn', () => {
    const offenders: string[] = [];
    for (const m of boundMigrations()) {
      const flat = m.sql.replace(/\s+/g, ' ').toLowerCase();
      if (!flat.includes('ca_diamond_rule_modes')) continue;
      // Any statement that mentions the rule modes table, one of the two
      // armed rules, and a mode that is not 'refuse'.
      const namesRule =
        flat.includes('dr2:balance_born_outside_the_mint') ||
        flat.includes('dr6:balance_changed_without_journal');
      const setsSoftMode =
        /mode\s*=\s*'(log|warn|off|disabled)'/.test(flat) ||
        /'(log|warn|off|disabled)'\s*(,|\))/.test(flat);
      if (namesRule && setsSoftMode) {
        offenders.push(
          `${m.file}: sets DR2 or DR6 to a mode other than 'refuse'. Those two rules ARE the fix for the 220,985 diamond journal gap; softening one reopens the door.`
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no migration drops or disables the two triggers that enforce it', () => {
    const guarded = ['zz_ca_diamond_born_with_balance', 'zz_ca_audit_diamond_change'];
    const offenders: string[] = [];
    for (const m of boundMigrations()) {
      const flat = m.sql.replace(/\s+/g, ' ').toLowerCase();
      for (const trigger of guarded) {
        if (!flat.includes(trigger)) continue;
        const dropped = new RegExp(`drop\\s+trigger[^;]*${trigger}`).test(flat);
        const disabled = new RegExp(
          `disable\\s+trigger\\s+${trigger}|disable\\s+trigger[^;]*${trigger}`
        ).test(flat);
        if (dropped || disabled) {
          offenders.push(
            `${m.file}: drops or disables ${trigger}. That trigger is what refuses a balance the journal cannot explain.`
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no migration opens a new born-with-balance door', () => {
    // An INSERT INTO public.profiles that names the diamonds column and gives
    // it a non-zero literal is precisely the pre-2026-09-01 signup path.
    const offenders: string[] = [];
    for (const m of boundMigrations()) {
      const flat = m.sql.replace(/\s+/g, ' ').toLowerCase();
      const inserts = flat.match(
        /insert\s+into\s+(public\.)?profiles\s*\(([^)]*)\)\s*values\s*\(([^;]*?)\)/g
      );
      if (!inserts) continue;
      for (const stmt of inserts) {
        const cols = (stmt.match(/\(([^)]*)\)/) || [])[1] || '';
        if (!/\bdiamonds\b/.test(cols)) continue;
        const columnList = cols.split(',').map((c) => c.trim());
        const idx = columnList.findIndex((c) => c === 'diamonds');
        if (idx < 0) continue;
        const valuesPart = stmt.slice(stmt.indexOf('values'));
        const values = (valuesPart.match(/\(([\s\S]*)\)/) || [])[1] || '';
        const value = (values.split(',')[idx] || '').trim();
        if (/^[1-9]\d*$/.test(value)) {
          offenders.push(
            `${m.file}: INSERT INTO profiles gives diamonds the literal ${value}. A profile is born holding 0 and the Mint grants under signup:<id>; this is the door that left 439 wallets unexplained.`
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the settlement migration changes no balance and does not register its rows', () => {
    const file = '20260930055147_the_journal_explains_the_balance.sql';
    const all = readdirSync(MIG_DIR);
    expect(all).toContain(file);
    const sql = stripComments(readFileSync(join(MIG_DIR, file), 'utf8'));
    const flat = sql.replace(/\s+/g, ' ').toLowerCase();

    // It must never move a balance: the ledger was wrong, not the wallet.
    expect(/update\s+(public\.)?profiles\b/.test(flat)).toBe(false);
    expect(/set\s+diamonds\s*=/.test(flat)).toBe(false);

    // Every settlement row is keyed per user, so a re-run cannot double it.
    expect(flat).toContain("'signup_bonus_journal:' || g.user_id::text");
    expect(flat).toContain("'journal_gap_settlement:' || g.user_id::text");

    // And every settlement row is marked so the register does not follow it.
    expect(flat).toContain("'journal_backfill'");

    // It asserts the board before writing and proves the result after.
    expect(flat).toContain('the board moved');
  });
});

/**
 * ===========================================================================
 *  A WALLET JOURNAL ROW MOVES THE WALLET (2026-10-07)
 * ===========================================================================
 *
 * The second way the journal stopped explaining a balance, and the converse of
 * DR6: not a balance that moved without a row, but a row written for a balance
 * that never moved.
 *
 * THE CAUSE, named to the line: fn_ca_diamond_sweep_cash_rake (20261005183028)
 * did
 *     INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,...)
 *     VALUES (v_p.user_id,'cash_rake','cash_rake',-v_p.amount::integer, ...)
 * for each payer, and did not touch profiles.diamonds - correctly, because the
 * rake had already left with the table stack and the payer's cash-out was
 * already smaller by it. So the rake was journalled twice. The hourly cron
 * (20261007034146) ran it six times before it was read: 46 rows, 13 wallets,
 * 4,460 Diamonds the journal could no longer explain.
 *
 * THE FIX: 20261007112751 makes the sweep retire the rake in the Mint register
 * itself (one player-holder burn per payer, no wallet movement) and write no
 * journal row. THE SETTLEMENT: 20261007112808 writes one correcting
 * 'cash_rake_correction' row per original row, moves no balance, and is marked
 * 'journal_backfill' so the register does not follow it.
 *
 * SAME CLASS, IN THE TOURNAMENT LANE (#6411): fn_poker_diamond_tournament_drain
 * journalled a house-bound tournament fee, Spin surplus or guarantee overlay
 * return from custody, and settle_overlay and spin_draw journalled the house's
 * overlay and underwrite into custody. The fee path wrote four -200 rows at
 * 13:03 UTC on 2026-10-07. 20261007132503 makes all five write the register
 * row directly and no journal row; the describe block below pins it.
 */
export const WALLET_ROW_BINDS_FROM = '20261007112751';

type FnDef = { file: string; version: string; name: string; body: string };

function functionDefinitions(sql: string, file: string, version: string): FnDef[] {
  const out: FnDef[] = [];
  const re =
    /create\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\([\s\S]*?\bas\s+(\$[a-z_]*\$)([\s\S]*?)\2/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    out.push({ file, version, name: m[1].replace(/"/g, '').toLowerCase(), body: m[3] });
  }
  return out;
}

function allMigrations(): Migration[] {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ version: (f.match(/^(\d{14})/) || [])[1] || '', file: f }))
    .filter((m) => m.version)
    .map((m) => ({ ...m, sql: stripComments(readFileSync(join(MIG_DIR, m.file), 'utf8')) }));
}

function latestDefinition(name: string): FnDef | undefined {
  let latest: FnDef | undefined;
  for (const m of allMigrations()) {
    for (const d of functionDefinitions(m.sql, m.file, m.version)) {
      if (d.name === name || d.name === `public.${name}`) latest = d;
    }
  }
  return latest;
}

const INSERTS_JOURNAL = /insert\s+into\s+(public\.)?diamond_transactions\b/i;
const MOVES_WALLET = /update\s+(public\.)?profiles\b[\s\S]*?\bset\b[\s\S]*?\bdiamonds\s*=/i;

describe('a wallet journal row moves the wallet', () => {
  it('no function written from 20261007112751 on journals a wallet movement it does not make', () => {
    const offenders: string[] = [];
    for (const m of allMigrations().filter((x) => x.version >= WALLET_ROW_BINDS_FROM)) {
      for (const d of functionDefinitions(m.sql, m.file, m.version)) {
        if (!INSERTS_JOURNAL.test(d.body)) continue;
        if (MOVES_WALLET.test(d.body)) continue;
        offenders.push(
          `${m.file}: ${d.name} inserts a diamond_transactions row and never moves profiles.diamonds. ` +
            'A wallet journal row is the record of a wallet movement; a movement that is not in the wallet ' +
            '(custody, the house, the register) belongs in its own record. This is how 46 cash_rake rows ' +
            'left 13 wallets 4,460 Diamonds unexplained.'
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Diamond cash rake sweep retires the rake in the register and writes no wallet journal row', () => {
    const sweep = latestDefinition('fn_ca_diamond_sweep_cash_rake');
    expect(sweep, 'fn_ca_diamond_sweep_cash_rake is defined in a migration').toBeDefined();
    expect(sweep!.version >= WALLET_ROW_BINDS_FROM).toBe(true);
    expect(sweep!.body).not.toMatch(/diamond_transactions/i);
    const flat = sweep!.body.replace(/\s+/g, ' ');
    expect(flat).toContain('INSERT INTO public.ca_mint_ledger');
    expect(flat).toMatch(/'burn', 'diamonds', 'player'/);
    // The wallet does not move, and the burn says so.
    expect(flat).toMatch(/COALESCE\(v_wallet,0\), COALESCE\(v_wallet,0\)/);
    // The retired-from-players assertion reads the burns themselves.
    expect(flat).toContain("m.op_id LIKE v_key||':%'");
    expect(flat).toContain('diamond_cash_rake_not_retired_from_players');
  });

  it('the register attribution carries only journal rows that moved the wallet', () => {
    // 20261007122947: a journal_backfill row (the cash rake corrections among
    // them) moves no balance, so carrying it put 8 chains off by exactly its sum.
    const attr = latestDefinition('fn_ca_mint_wallet_attribution');
    expect(attr, 'fn_ca_mint_wallet_attribution is defined in a migration').toBeDefined();
    const flat = attr!.body.replace(/\s+/g, ' ');
    expect(flat).toContain("COALESCE(t.source, '') <> 'journal_backfill'");
    expect(flat).toContain('fn_ca_diamond_journal_origin(');
  });

  it('the cash rake settlement changes no balance, corrects row for row, and stays out of the register', () => {
    const file = '20261007112808_the_cash_rake_journal_rows_are_settled.sql';
    expect(readdirSync(MIG_DIR)).toContain(file);
    const flat = stripComments(readFileSync(join(MIG_DIR, file), 'utf8'))
      .replace(/\s+/g, ' ')
      .toLowerCase();
    expect(/update\s+(public\.)?profiles\b/.test(flat)).toBe(false);
    expect(/set\s+diamonds\s*=/.test(flat)).toBe(false);
    expect(/delete\s+from\s+(public\.)?diamond_transactions/.test(flat)).toBe(false);
    expect(/update\s+(public\.)?diamond_transactions/.test(flat)).toBe(false);
    expect(flat).toContain("'cash_rake_correction:' || r.id::text");
    expect(flat).toContain("'journal_backfill'");
    expect(flat).toContain('the board moved');
    // It refuses to run before the live writer is fixed.
    expect(flat).toContain('apply 20261007112751 first');
    // Horses are players (CLAUDE.md 10.5): the cohort is the rows, nothing else.
    expect(flat).not.toMatch(/is_horse/);
  });
});

/**
 * ===========================================================================
 *  THE TOURNAMENT LANE'S HOUSE LEGS MOVE NO WALLET (#6411, 2026-10-07)
 * ===========================================================================
 *
 * A Diamond tournament fee, a Spin surplus and a guarantee overlay return leave
 * an entry's custody for the house; a Spin underwrite and a guarantee overlay
 * arrive in custody from the house. None of the five touches a wallet: the
 * entry's Diamonds left the wallet once, in its arena_deposit row. Each one
 * nevertheless wrote a diamond_transactions row, and from 13:03 UTC four
 * wallets' journals stopped explaining their balances.
 *
 * 20261007132503 writes the register row (which counts custody Diamonds as the
 * player's) directly, with the wallet unchanged on both sides, writes no
 * journal row, and has the callers assert the register by op_id. The movement
 * CHECK admits a NULL journal id on the two house legs only.
 */
const LANE_FIX = '20261007132503';

describe("the tournament lane's house legs write no wallet journal row", () => {
  const lane = [
    'fn_poker_diamond_tournament_drain',
    'fn_poker_diamond_tournament_settle_fee',
    'fn_poker_diamond_tournament_settle_overlay',
    'fn_poker_diamond_spin_draw',
    'fn_diamond_arena_reconciliation',
  ];

  it.each(lane)('%s is last defined at or after the fix, and journals no house leg', (name) => {
    const d = latestDefinition(name);
    expect(d, `${name} is defined in a migration`).toBeDefined();
    expect(d!.version >= LANE_FIX).toBe(true);
    expect(d!.body).not.toMatch(INSERTS_JOURNAL);
  });

  it('the drain retires a house-bound drain in the register, wallet unchanged, and still carries a prize journal', () => {
    const flat = latestDefinition('fn_poker_diamond_tournament_drain')!.body.replace(/\s+/g, ' ');
    expect(flat).toContain("v_register := p_reason||':'||v_c.id::text;");
    expect(flat).toContain("(v_register, 'burn', 'diamonds', 'player', v_c.user_id");
    expect(flat).toContain('COALESCE(v_wallet,0), COALESCE(v_wallet,0), v_supply');
    // A prize or bounty drain still carries the recipient's wallet credit.
    expect(flat).toContain('IF p_journal_for IS NOT NULL THEN v_journal := p_journal_for;');
    expect(flat).toContain("'register_op_id',v_register");
  });

  it('every caller asserts the register by op_id, never through journal ids', () => {
    for (const name of [
      'fn_poker_diamond_tournament_settle_fee',
      'fn_poker_diamond_tournament_settle_overlay',
      'fn_poker_diamond_spin_draw',
    ]) {
      const body = latestDefinition(name)!.body;
      expect(body, `${name} still asserts through diamond_tx_id`).not.toContain('diamond_tx_id');
      expect(body).toMatch(/m\.op_id (IN \(SELECT d->>'register_op_id'|= ANY \(v_registers\))/);
    }
  });

  it('the overlay and the underwrite are registered to the player with the wallet unchanged', () => {
    const overlay = latestDefinition('fn_poker_diamond_tournament_settle_overlay')!.body.replace(
      /\s+/g,
      ' '
    );
    expect(overlay).toContain("(v_register, 'mint', 'diamonds', 'player', v_c.user_id");
    expect(overlay).toContain('v_wallet, v_wallet, v_running');
    const spin = latestDefinition('fn_poker_diamond_spin_draw')!.body.replace(/\s+/g, ' ');
    expect(spin).toContain("(v_register, 'mint', 'diamonds', 'player', v_c.user_id");
    expect(spin).toContain('v_wallet, v_wallet, v_running');
  });

  it('the movement CHECK admits a missing journal id on the two house legs only', () => {
    const file = readdirSync(MIG_DIR).find((f) => f.startsWith(LANE_FIX));
    expect(file, 'the lane fix migration is on disk').toBeDefined();
    const flat = stripComments(readFileSync(join(MIG_DIR, file!), 'utf8')).replace(/\s+/g, ' ');
    // A wallet leg still needs its journal row.
    expect(flat).toContain(
      '((amount >= 1 AND amount <= 2147483647) AND wallet_journal_id IS NOT NULL)'
    );
    // Only custody to the house by a drain, or the house into custody.
    expect(flat).toContain(
      "(action = 'release' AND source_account LIKE 'arena_custody:%' AND destination_account = 'house' AND request->>'action' = 'tournament_drain')"
    );
    expect(flat).toContain(
      "(action = 'reserve' AND source_account LIKE 'house:%' AND destination_account LIKE 'arena_custody:%' AND request->>'action' IN ('spin_underwrite', 'guarantee_overlay'))"
    );
    // The inflow constraint, which holds entries to their journal rows, is untouched.
    expect(flat).not.toContain('poker_diamond_tournament_ledger_inflow');
    // Both watched guards are declared, never disabled.
    expect(flat).toContain('fn_ca_declare_guard_redefinition');
    expect(flat).toContain(
      "'fn_poker_diamond_tournament_drain', 'fn_poker_diamond_tournament_settle_fee'"
    );
    expect(flat).not.toMatch(/disable\s+trigger/i);
  });
});

describe("the tournament lane's journal rows are settled without moving a balance", () => {
  it('corrects row for row, moves no balance, stays out of the register, and refuses to run first', () => {
    const file = '20261007134548_the_diamond_tournament_lane_journal_rows_are_settled.sql';
    expect(readdirSync(MIG_DIR)).toContain(file);
    const flat = stripComments(readFileSync(join(MIG_DIR, file), 'utf8'))
      .replace(/\s+/g, ' ')
      .toLowerCase();
    expect(/update\s+(public\.)?profiles\b/.test(flat)).toBe(false);
    expect(/set\s+diamonds\s*=/.test(flat)).toBe(false);
    expect(/delete\s+from\s+(public\.)?diamond_transactions/.test(flat)).toBe(false);
    expect(/update\s+(public\.)?diamond_transactions/.test(flat)).toBe(false);
    expect(flat).toContain("'tournament_lane_correction:' || r.id::text");
    expect(flat).toContain("'journal_backfill'");
    expect(flat).toContain('the board moved');
    // It refuses to run before the live writers are fixed.
    expect(flat).toContain('apply 20261007132503 first');
    // Horses are players (CLAUDE.md 10.5): the cohort is the rows, nothing else.
    expect(flat).not.toMatch(/is_horse/);
  });
});
