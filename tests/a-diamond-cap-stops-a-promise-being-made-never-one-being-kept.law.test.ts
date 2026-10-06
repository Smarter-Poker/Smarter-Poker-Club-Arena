/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A DIAMOND CAP STOPS A PROMISE BEING MADE, NEVER ONE BEING KEPT (2026-10-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 9 line (a) of the Diamond Arena programme answered twenty questions
 * (A1 to A20 of docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md). Six of the
 * answers are caps - A3, A5 and A8 on guarantees, A13, A14 and A15 on
 * promotional entries - and ruling 21 (Dan, 2026-09-08: "THERE SHOULDN'T BE A
 * PLATFORM BUDGET ON THINGS LIKE THIS, ONLY A USER BUDGET.") forbids a
 * platform pot refusing a player.
 *
 * The two are reconciled by WHERE the caps are checked, and nowhere else, so
 * the place is what this law pins:
 *
 *   A cap is read on an 'open' entry in the house earmark ledger - a promise
 *   being MADE, before any player has been told a prize exists. A 'pay' entry,
 *   the house keeping a promise to a named player, and a 'release' entry
 *   return from the guard BEFORE the first cap is read, so no value in
 *   ca_diamond_economics can stand between a player and a promise already
 *   made. Proved live on 2026-10-05 in a rolled-back transaction: with
 *   guarantee_max_per_event and guarantee_max_outstanding both rewritten to 0,
 *   a new 1-Diamond promise was refused and a 250,000 promise already open was
 *   paid in full.
 *
 * AND THE HALF THAT KEEPS THE BOOKS WHOLE: an earmark is not a movement (rule
 * R3). It lowers fn_ca_diamond_house_available() and touches neither
 * ca_diamond_house.balance, ca_mint_ledger nor fn_ca_arena_diamonds(), so the
 * supply identity never sees a promise. Measured in the same transaction:
 * thirteen opens, two pays and a release left
 * fn_ca_diamond_register_vs_supply().difference exactly where it started.
 *
 * AND THE HALF THAT KEEPS AN UNSET VALUE HONEST: fn_ca_diamond_economic and
 * fn_ca_diamond_economic_text never return NULL, never fall back from a stake
 * scope to 'all', never fall back to a chip value or a literal, and refuse by
 * name under SQLSTATE PDE01. A switch nobody has set is not "off".
 *
 * Registry: docs/laws.d/a-diamond-cap-stops-a-promise-being-made-never-one-being-kept.md
 */
import { describe, expect, it } from 'vitest';
import { latestDeclaring, migrationFiles, readMigration } from './helpers/migrations';

const GUARD = 'fn_ca_diamond_earmark_guard';
const { name: GUARD_MIGRATION, sql: GUARD_SQL } = latestDeclaring(GUARD);

const READER = 'fn_ca_diamond_economic';
const { name: READER_MIGRATION, sql: READER_SQL } = latestDeclaring(READER);

/** The migration that BUILT THE TABLE AND SEEDED THE TWENTY ANSWERS.
 *
 *  Until 2026-10-06 this was always the same file as the one declaring the
 *  reader, so the two halves of this law were asserted against READER_SQL
 *  together. They are no longer the same file, and the reason is itself part of
 *  the law: 20261005151712 ran when its own header said it must never run and
 *  replaced both readers WITHOUT their p_scope DEFAULT, which broke six live
 *  money-path functions at runtime. A default cannot be added back by CREATE OR
 *  REPLACE - PostgreSQL answers 42P13 - so the repair had to DROP and CREATE
 *  the readers, and the latest migration declaring the reader is now that
 *  repair.
 *
 *  A repair MUST NOT re-seed. ca_diamond_economics is append-only and a settled
 *  answer is never written twice; the twenty answers are still exactly the rows
 *  the A-lane wrote. So this law now resolves each fact where that fact lives.
 *  Every assertion below is the one that was always made, against the same
 *  content as before - only the file each one is made against is now FOUND by
 *  what it contains instead of assumed to be the reader's. Nothing is relaxed:
 *  the arena-switch check below gained a file rather than losing one.
 *
 *  The anchor is A1's seeded row. If a later migration ever re-seeds the twenty,
 *  this follows it there. */
function latestContaining(anchor: string): { name: string; sql: string } {
  const hits = migrationFiles().filter((f) => readMigration(f).includes(anchor));
  expect(hits.length, `no migration contains ${anchor}`).toBeGreaterThan(0);
  const name = hits[hits.length - 1];
  return { name, sql: readMigration(name) };
}

const { name: ANSWERS_MIGRATION, sql: ANSWERS_SQL } = latestContaining(
  "('guarantee_overlay_account', 'all'"
);

/** A function body with its SQL line comments removed: prose explains, it
 *  does not execute, and "ruling 21" is not a priced-in default. */
function codeOf(body: string): string {
  return body
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

function bodyOf(sql: string, fn: string): string {
  const at = sql.indexOf(`CREATE FUNCTION public.${fn}(`);
  expect(at, `${fn} is not created in its own migration`).toBeGreaterThan(-1);
  const open = sql.indexOf('$$', at);
  const close = sql.indexOf('$$', open + 2);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open + 2, close);
}

describe(`${GUARD} (in force: ${GUARD_MIGRATION})`, () => {
  const body = bodyOf(GUARD_SQL, GUARD);

  it('returns on a pay or a release before it reads its first cap', () => {
    const payBranch = body.indexOf("IF NEW.entry IN ('pay','release') THEN");
    const firstCap = body.indexOf('fn_ca_diamond_economic(');
    expect(payBranch, 'the guard has no pay and release branch').toBeGreaterThan(-1);
    expect(firstCap, 'the guard reads no cap from ca_diamond_economics').toBeGreaterThan(-1);
    // This single ordering IS the law. If a cap is ever read above the pay
    // branch, a platform pot can refuse a player (ruling 21).
    expect(payBranch).toBeLessThan(firstCap);
    expect(body.slice(payBranch, firstCap)).toContain('RETURN NEW;');
  });

  it('reads every cap by name from the settings table, never as a literal', () => {
    for (const name of [
      'guarantee_max_per_event',
      'guarantee_max_outstanding',
      'promo_entry_allowed',
      'promo_entry_expiry_days',
      'promo_entry_per_player_per_day',
      'promo_entry_per_event',
      'promo_entry_monthly_diamonds',
    ]) {
      expect(body, `the guard no longer reads ${name}`).toContain(name);
    }
    // No bare number may stand in for an answer. The only integer literals
    // the guard is allowed are 1 (the row it locks and the entry it counts)
    // and 0 (the comparisons), so any other is a priced-in default.
    const literals = (codeOf(body).match(/(?<![\w:'.])\d+(?![\w'.])/g) ?? []).filter(
      (n) => n !== '0' && n !== '1'
    );
    expect(literals, `the guard holds numeric literals: ${literals.join(', ')}`).toEqual([]);
  });

  it('refuses a promise the house cannot set aside, which is what A7 means', () => {
    expect(body).toContain('fn_ca_diamond_house_available()');
    expect(body).toContain('diamond_house_cannot_set_aside');
  });

  it('never branches on horse status (CLAUDE.md 10.5)', () => {
    expect(body).not.toContain('is_horse');
    expect(body).not.toMatch(/bot_profiles/);
  });

  it('is a BEFORE INSERT trigger on the earmark ledger, and nothing else', () => {
    expect(GUARD_SQL).toMatch(
      /CREATE TRIGGER trg_ca_diamond_earmark_guard\s+BEFORE INSERT ON public\.ca_diamond_house_earmarks\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.fn_ca_diamond_earmark_guard\(\);/
    );
  });
});

describe('the house earmark ledger is append-only and holds no Diamond', () => {
  it('refuses every update, delete and truncate', () => {
    expect(GUARD_SQL).toMatch(
      /CREATE TRIGGER trg_ca_diamond_house_earmarks_append_only\s+BEFORE UPDATE OR DELETE ON public\.ca_diamond_house_earmarks/
    );
    expect(GUARD_SQL).toMatch(
      /CREATE TRIGGER trg_ca_diamond_house_earmarks_no_truncate\s+BEFORE TRUNCATE ON public\.ca_diamond_house_earmarks/
    );
  });

  it('is not reachable from a browser', () => {
    expect(GUARD_SQL).toMatch(
      /REVOKE ALL ON TABLE public\.ca_diamond_house_earmarks FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(GUARD_SQL).not.toMatch(
      /GRANT [A-Z, ]*ON TABLE public\.ca_diamond_house_earmarks TO (anon|authenticated)/
    );
  });

  it('available is the balance less what is promised, and the promise moves nothing', () => {
    const avail = bodyOf(GUARD_SQL, 'fn_ca_diamond_house_available');
    expect(avail).toContain('ca_diamond_house');
    expect(avail).toContain('fn_ca_diamond_earmarks_open');
    // R3: a promise is not supply. An earmark that reached the register or the
    // arena float would be counted as Diamonds that do not exist yet.
    const guard = codeOf(bodyOf(GUARD_SQL, GUARD));
    for (const moved of ['ca_mint_ledger', 'fn_ca_arena_diamonds', 'ca_diamond_house_ledger']) {
      expect(guard, `the earmark guard reaches ${moved}`).not.toContain(moved);
      expect(codeOf(avail), `available reaches ${moved}`).not.toContain(moved);
    }
    expect(codeOf(GUARD_SQL)).not.toMatch(/INSERT INTO public\.ca_mint_ledger/);
    expect(codeOf(GUARD_SQL)).not.toMatch(/UPDATE public\.ca_diamond_house\s+SET/);
    // And the migration proves the identity is still whole when it ends.
    expect(GUARD_SQL).toContain('the Diamond identity is not whole');
  });

  it('keeps a chip account out of a Diamond promise (ruling 16)', () => {
    for (const chip of [
      'chip_treasury',
      'chip_ledger',
      'union_wallets',
      'club_members',
      'fn_horse_fund_from_treasury',
      'bbj_pools',
      'rake_records',
    ]) {
      expect(GUARD_SQL, `the earmark ledger names ${chip}`).not.toContain(chip);
    }
  });
});

describe(`${READER} (reader in force: ${READER_MIGRATION}; answers seeded by: ${ANSWERS_MIGRATION})`, () => {
  it('refuses an unset value by name under its own SQLSTATE, and never returns NULL', () => {
    for (const fn of ['fn_ca_diamond_economic', 'fn_ca_diamond_economic_text']) {
      const body = bodyOf(READER_SQL, fn);
      expect(body).toContain('diamond_economics_unset:');
      expect(body).toContain("USING ERRCODE = 'PDE01'");
      // The refusal names the value, so a client can read WHICH answer is
      // missing rather than being told "something is not configured".
      expect(body).toMatch(/diamond_economics_unset:%\/%/);
      // No fallback of any kind: the scope asked for is the scope read.
      expect(body).not.toMatch(/scope\s*=\s*'all'\s*\)?\s*ORDER/);
      expect(body).not.toContain('COALESCE(e.value');
      expect(body).not.toContain('chip');
    }
  });

  it('is never the one that decides a default', () => {
    const body = bodyOf(READER_SQL, 'fn_ca_diamond_economic');
    const literals = (codeOf(body).match(/(?<![\w:'.])\d+(?![\w'.])/g) ?? []).filter(
      (n) => n !== '1'
    );
    expect(literals, `the reader holds numeric literals: ${literals.join(', ')}`).toEqual([]);
  });

  it('a switch nobody set is not off', () => {
    const on = bodyOf(READER_SQL, 'fn_ca_diamond_economic_on');
    // It goes through the refusing text reader, so an unset switch raises
    // rather than comparing NULL to 'yes' and quietly reading as false.
    expect(on).toContain('fn_ca_diamond_economic_text');
    expect(on).not.toContain('COALESCE');
  });

  it('the settings table is append-only, and a value cannot be stored in the wrong unit', () => {
    expect(ANSWERS_SQL).toMatch(
      /CREATE TRIGGER trg_ca_diamond_economics_append_only\s+BEFORE UPDATE OR DELETE ON public\.ca_diamond_economics/
    );
    expect(ANSWERS_SQL).toContain('ca_diamond_economics_units_match_name');
    expect(ANSWERS_SQL).toContain('ca_diamond_economics_quote_not_empty');
    expect(ANSWERS_SQL).toContain('ca_diamond_economics_basis_not_empty');
    expect(ANSWERS_SQL).toMatch(
      /REVOKE ALL ON TABLE public\.ca_diamond_economics FROM PUBLIC, anon, authenticated, service_role;/
    );
  });

  it('records all twenty answers, each with the owner words and the derivation behind it', () => {
    for (const name of [
      'guarantee_overlay_account',
      'guarantee_mint_may_issue',
      'guarantee_mint_monthly_ceiling',
      'guarantee_max_per_event',
      'guarantee_max_outstanding',
      'guarantee_covers',
      'guarantee_funding_moment',
      'guarantee_cap_refuses_creation',
      'guarantee_authority',
      'freeroll_allowed',
      'freeroll_rebuy_cost',
      'freeroll_addon_cost',
      'promo_entry_allowed',
      'promo_entry_per_player_per_day',
      'promo_entry_per_event',
      'promo_entry_monthly_diamonds',
      'promo_entry_refund_destination',
      'promo_entry_expiry_days',
      'horse_entry_funding',
      'horse_overlay_autofill',
      'horse_freeroll_autofill',
    ]) {
      expect(ANSWERS_SQL, `${name} is not recorded`).toContain(`('${name}', 'all'`);
    }
    // The chain that keeps the three guarantee numbers honest, asserted by the
    // migration itself so a later row cannot quietly break it.
    expect(ANSWERS_SQL).toContain('the guarantee chain is broken');
  });

  it('seeds no fee, rake or BBJ answer: a running fee is not changed by a settings migration', () => {
    expect(ANSWERS_SQL).toContain('a B answer was seeded');
    // A seeded answer is a VALUES row beginning a line. The migration DOES
    // name cash_rake_percent once, in its own proof that an unset value
    // refuses by name, and that is the opposite of seeding it.
    for (const b of ['tournament_fee_percent', 'cash_rake_percent', 'bbj_enabled']) {
      expect(ANSWERS_SQL, `${b} was seeded`).not.toMatch(new RegExp(`^\\('${b}',`, 'm'));
    }
    expect(ANSWERS_SQL).toContain("fn_ca_diamond_economic('cash_rake_percent', 'bb:2')");
  });

  it('answers A18, A19 and A20 the way CLAUDE.md 10.5 requires, not the way Phase 8 assumed', () => {
    // A horse pays its own entry through the same door a person uses. The
    // alternative - the house funding every horse seat while humans fund
    // their own - is the "equal outcome by a different mechanism" Dan
    // rejected outright on 2026-08-27.
    expect(ANSWERS_SQL).toContain("('horse_entry_funding', 'all', NULL, 'own_balance'");
    expect(ANSWERS_SQL).toContain("('horse_overlay_autofill', 'all', NULL, 'yes'");
    expect(ANSWERS_SQL).toContain("('horse_freeroll_autofill', 'all', NULL, 'yes'");
    // And the only funding choice a horse row may ever carry is one of the two
    // the question offered, so no third mechanism can be invented later.
    expect(ANSWERS_SQL).toMatch(
      /WHEN 'horse_entry_funding'\s+THEN value_text IN \('own_balance','funding_account'\)/
    );
  });

  it('opens neither arena switch', () => {
    expect(ANSWERS_SQL).toContain('this migration must not open the Diamond cash door');
    /* Every migration this law speaks for, not just the seeding one. The
       repair that restored the readers is held to it too. */
    for (const sql of [ANSWERS_SQL, READER_SQL, GUARD_SQL]) {
      expect(sql).not.toMatch(/UPDATE public\.ca_arena_settings/);
    }
  });
});
