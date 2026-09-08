/**
 * THE DIAMOND ARENA IS ONE CLUB, CREATING IT MINTS NOTHING, AND ITS MONEY IS
 * COUNTED WHERE IT ACTUALLY IS.
 *
 * Phase 5 of the diamond roadmap. Every pin below is a defect that was live in
 * production or one INSERT away from it on 2026-09-08.
 *
 *  1. A CLUB THAT DOES NOT PLAY IN CHIPS GETS NO CHIP OPENING BANK.
 *     `fn_seed_new_club_opening_bank` sets `chip_treasury := 100000` on every
 *     non-union club, with no reference to `asset`, and
 *     `fn_record_new_club_opening_bank` registers that as a mint of 100,000
 *     CHIPS. Inserting the Diamond Arena unchanged would have created a hundred
 *     thousand chips inside a club that plays in diamonds. A chip club still
 *     gets its grant - the rolled-back probe created one and checked.
 *
 *  2. THERE IS EXACTLY ONE PLATFORM CLUB, by a partial unique index rather than
 *     by hope. Ruling 16 and standard 3.2 both say one; nothing enforced it.
 *
 *  3. AN ARENA MOVEMENT IS A TRANSFER, NOT ISSUANCE AND NOT RETIREMENT.
 *     `fn_ca_diamond_journal_origin` called a deposit `spend`, so the register
 *     would have BURNED every diamond parked on the felt and understated the
 *     platform's own liability by the whole float; it called a withdrawal
 *     `arena`, which the register reads as a MINT, so taking your own diamonds
 *     back would have created them again.
 *
 *  4. THE IDENTITY COUNTS THE FELT. `players + house = register` was true only
 *     while no diamond could sit anywhere else. It is `players + house + arena`
 *     now, and the deploy gate's basis includes the arena on BOTH sides so a
 *     deposit nets to zero instead of reading as unexplained.
 *
 *  5. THE CHIP SUPPLY SNAPSHOT DOES NOT COUNT DIAMONDS. Arena member wallets
 *     live in `club_members.chip_balance` and are denominated in diamonds; all
 *     six aggregates exclude the platform club.
 *
 *  6. A HORSE MAY PLAY IN THE ARENA (CLAUDE.md 10.5). The house-board rule was
 *     a bare list of four uuids, so the platform club was locked out of its own
 *     category the day it was created. It is derived from `is_platform` now.
 *     The guard must still refuse an ordinary club: widening it would be worse
 *     than the bug it fixed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (needle: string) => {
  const f = files.find((x) => x.includes(needle));
  if (!f) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, f), 'utf8');
};
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

describe('the arena club mints nothing', () => {
  const club = read('the_arena_gets_its_club');

  it('refuses the chip opening grant to a club that plays in another asset', () => {
    expect(code(club)).toContain("IF COALESCE(NEW.asset, 'chips') <> 'chips' THEN");
    // both halves: the seeder that sets it and the recorder that registers it
    const guards = code(club).match(/COALESCE\(NEW\.asset, 'chips'\) <> 'chips'/g) ?? [];
    expect(guards.length).toBe(2);
  });

  it('still gives a chip club its opening bank', () => {
    expect(code(club)).toContain('NEW.chip_treasury := 100000');
    expect(code(club)).toContain("'mint', 'chips', 'club'");
  });

  it('allows only one platform club', () => {
    expect(code(club)).toContain('CREATE UNIQUE INDEX IF NOT EXISTS ca_clubs_one_platform_club');
    expect(code(club)).toContain('WHERE is_platform');
  });

  it('creates the club owned by the service identity, never a person', () => {
    expect(code(club)).toContain("'2d1cd6c3-5700-4af9-a271-d4863fdab20d'");
    expect(club).toContain('10.10 rule 2');
  });

  it('asserts that creating it minted nothing in either currency', () => {
    expect(code(club)).toContain("public.fn_ca_mint_supply('chips') <> v_chips_before");
    expect(code(club)).toContain("public.fn_ca_mint_supply('diamonds') <> v_diamonds_before");
  });

  it('points ca_arena_settings at it', () => {
    expect(code(club)).toContain('UPDATE public.ca_arena_settings SET club_id = v_club');
  });
});

describe('the books count the felt', () => {
  const books = read('the_books_learn_the_arena');

  it('treats a deposit and a withdrawal as transfers, not issuance', () => {
    expect(code(books)).toContain(
      "IF v_kind IN ('arena_deposit', 'arena_withdraw') THEN RETURN NULL; END IF;"
    );
  });

  it('stops the arena class from minting on the positive side', () => {
    expect(code(books)).toContain("ELSIF v_kind LIKE 'arcade%' THEN");
    // the old branch, which made a withdrawal mint, must be gone from the replacement
    const replacements = (books.match(/\$ca_to\$[\s\S]*?\$ca_to\$/g) ?? []).join('\n');
    expect(replacements).not.toContain("ELSIF v_class = 'arena' OR v_kind LIKE 'arcade%'");
  });

  it('adds arena_wallets to the trial balance and to the identity', () => {
    expect(code(books)).toContain("'arena_wallets'::text, v_arena");
    expect(code(books)).toContain('(v_players + v_house + v_arena) - v_reg');
  });

  it('puts the arena on both sides of the deploy gate basis', () => {
    expect(code(books)).toContain('v_total := v_prof + v_arena_now;');
    expect(code(books)).toContain(
      'v_prev_basis := prev.profile_diamonds + COALESCE(prev.arena_diamonds, 0);'
    );
  });

  it('excludes the platform club from every chip supply aggregate', () => {
    const replacements = (books.match(/\$ca_to\$[\s\S]*?\$ca_to\$/g) ?? []).join('\n');
    const excl = replacements.match(/is_platform/g) ?? [];
    expect(excl.length).toBeGreaterThanOrEqual(6);
  });

  it('asserts the identity including the arena before it commits', () => {
    expect(code(books)).toContain('public.fn_ca_arena_diamonds()');
    expect(code(books)).toContain('players + arena <> register');
  });
});

describe('a horse may play in the arena', () => {
  const horse = read('a_horse_may_play_in_the_arena');

  it('derives the house board from is_platform instead of a bare list', () => {
    expect(code(horse)).toContain(
      'SELECT COALESCE((SELECT c.is_platform FROM public.clubs c WHERE c.id = p_club_id), false)'
    );
  });

  it('keeps the four legacy boards working', () => {
    for (const id of [
      'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
      'a0000000-0000-0000-0000-000000000001',
      'fade0000-0000-0000-0000-000000000001',
      '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',
    ]) {
      expect(code(horse)).toContain(id);
    }
  });

  it('still refuses every club that is neither the platform club nor a legacy board', () => {
    expect(code(horse)).toContain('the guard lets an automated player into club');
    expect(code(horse)).toContain('a club that does not exist reads as a house board');
  });

  it('does not widen the guard by appending a fifth uuid', () => {
    expect(code(horse)).toContain('the house board rule is still a bare list');
  });
});
