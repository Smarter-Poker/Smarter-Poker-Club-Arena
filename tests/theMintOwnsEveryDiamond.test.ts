import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * THE MINT OWNS EVERY DIAMOND (Dan, 2026-09-04): "all diamond wallets need to
 * be connected to The Mint. That's where all purchased diamonds come from, and
 * all earned diamonds derive and send from the Mint."
 *
 * 20260905041033 made the register follow the diamond journal. 20260905064901
 * fixed the two things that made it disagree with the meter within the hour.
 * Both are pinned here because both were real, measured production defects.
 */
const ROOT = resolve(__dirname, '..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');

const migration = (fragment: string): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(fragment));
  if (!file) throw new Error(`no migration matching "${fragment}"`);
  return readFileSync(resolve(MIGRATIONS, file), 'utf8');
};

const FOLLOWS = migration('one_mint_for_diamonds');
const CORRECTS = migration('the_signup_grant_is_registered_once');

describe('the diamond register follows the diamond journal', () => {
  it('every journal insert is offered to the register by a trigger', () => {
    expect(FOLLOWS).toContain('CREATE TRIGGER trg_ca_diamond_register_follows_journal');
    expect(FOLLOWS).toContain('AFTER INSERT ON public.diamond_transactions');
    expect(FOLLOWS).toContain('fn_ca_register_diamond_journal_row');
  });

  it('bookkeeping never blocks the money: a failed register files an incident', () => {
    // The diamonds already moved and the journal row stands. A register that
    // could not be written is an incident, not a refused purchase.
    expect(FOLLOWS).toContain("'MINT:register_follow_failed'");
    expect(FOLLOWS).toContain('EXCEPTION WHEN OTHERS THEN');
  });

  it('one register row per journal row, enforced structurally', () => {
    expect(FOLLOWS).toContain('CREATE UNIQUE INDEX IF NOT EXISTS ca_mint_ledger_diamond_tx_id_key');
  });

  it('the reconciliation reads the live meter, not a stored total', () => {
    expect(FOLLOWS).toContain('fn_ca_diamond_register_vs_supply');
    expect(FOLLOWS).toContain('FROM public.profiles');
    expect(FOLLOWS).toContain('FROM public.ca_diamond_house');
  });
});

describe('a movement is registered exactly once', () => {
  it("the Mint's own doors are not registered a second time", () => {
    expect(CORRECTS).toContain("IF v_src = 'the_mint' THEN RETURN NULL; END IF;");
  });

  it('nor is the signup grant, which the seed door already registers', () => {
    // 2026-09-05: fn_ca_diamond_born_with_balance writes its own 'seed:<id>'
    // register row AND the signup_bonus journal row. Registering the journal
    // row here too counted one movement twice - 18 duplicate pairs, 9,000
    // diamonds, both rows reading balance_before 0 / balance_after 500.
    expect(CORRECTS).toContain(
      "IF v_kind = 'signup_bonus' OR v_src = 'handle_new_user' THEN RETURN NULL; END IF;"
    );
  });

  it('but every OTHER promotional credit still registers', () => {
    // The exclusion is a named writer, never the 'promotional' class: the
    // daily_login and easter_egg rewards have no other register row.
    expect(CORRECTS).toContain("RETURN 'promotion';");
    expect(CORRECTS).toContain(
      "IF public.fn_ca_diamond_journal_origin('easter_egg', 'easter_egg', NULL, 'promotional', 250) <> 'promotion' THEN"
    );
    expect(CORRECTS).toContain(
      "IF public.fn_ca_diamond_journal_origin('earn', 'signup_bonus', 'handle_new_user', 'promotional', 500) IS NOT NULL THEN"
    );
  });
});

describe('deletion retires what the Mint still attributes', () => {
  it('burns the greater of the balance and the registered attribution', () => {
    // Never smaller than the balance this trigger burned before 2026-09-05,
    // so the healthy case cannot regress; it also retires a seed that a
    // harness zeroed outside the journal.
    expect(CORRECTS).toContain(
      'v_burn := GREATEST(COALESCE(OLD.diamonds, 0), COALESCE(v_attributed, 0));'
    );
    expect(CORRECTS).toContain(
      "WHERE asset = 'diamonds' AND holder_type = 'player' AND holder_id = OLD.id"
    );
  });

  it('still archives the journal and still files DR5 on a real balance', () => {
    expect(CORRECTS).toContain('ca_diamond_journal_archive');
    expect(CORRECTS).toContain("'DR5:deleted_with_balance'");
  });

  it('records a retirement without moving a balance or blocking the delete', () => {
    expect(CORRECTS).toContain('RETURN OLD;');
    expect(CORRECTS).not.toContain('UPDATE public.profiles');
  });
});

describe('both migrations assert their own arithmetic', () => {
  it.each([
    ['20260905041033', FOLLOWS],
    ['20260905064901', CORRECTS],
  ])('%s aborts if the register does not equal the meter', (_version, sql) => {
    expect(sql).toContain(
      'SELECT difference INTO v_gap FROM public.fn_ca_diamond_register_vs_supply();'
    );
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('IF v_gap <> 0 THEN');
  });

  it('the correction is sized at apply time, never hardcoded', () => {
    // The certification harness may run between writing the migration and
    // applying it, so the gap is read from the reconciliation, not typed in.
    expect(CORRECTS).toContain('INTO v_reg, v_meter, v_players, v_house, v_gap');
    expect(CORRECTS).toContain('abs(v_gap)');
    expect(CORRECTS).not.toMatch(/amount[^\n]*\b18000\b/);
  });
});
