/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A TOURNAMENT STACK IS NOT A DIAMOND
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Diamond Money Contract: "Tournament playing stacks are nonredeemable
 * tournament units. Entry and prize money are diamonds. Tournament units must
 * never become withdrawable diamonds just because the UI uses diamond
 * artwork."
 *
 * Until 2026-09-13 the arena enforced the opposite by accident. Three guards -
 * `fn_poker_guard_chip_seat`, `fn_poker_bind_diamond_seat` and
 * `fn_poker_diamond_seat_keeps_custody` - branched on `clubs.asset='diamonds'`
 * and nothing else, and between them asserted ONE equation for every Diamond
 * seat there is:
 *
 *     table_seats.stack = poker_diamond_custody.balance
 *
 * For cash that equation IS the product: the stack a player sits down with is
 * exactly the Diamonds held for that seat, which is what makes a cash-out
 * correct. For a tournament it is a category error, and a 10,000-unit starting
 * stack would have demanded 10,000 real Diamonds.
 *
 * THE DANGER THIS LAW EXISTS FOR. "A Diamond playing stack cannot reach a
 * wallet" used to be true BY THAT ACCIDENT: a Diamond seat simply WAS its
 * custody, so there was no such thing as a stack that was not already real
 * Diamonds. Breaking the equation removes a guard. The migration that broke it
 * replaced it, in the same transaction, with an explicit rule, and this law is
 * what keeps the replacement from being quietly deleted - or from being
 * "restored" by an agent who reads the cash equation, sees it missing on a
 * tournament seat, and puts it back.
 *
 * THE RULE, POSITIVELY:
 *
 *   A Diamond tournament seat is admitted by a FUNDED ENTRY, never by its
 *   stack. The stack is a play unit and bears no relation to custody. The
 *   money is the ENTRY: one custody row, bound to the tournament and never to
 *   a seat, holding exactly what was reserved for it and nothing that play
 *   produced.
 *
 * Every window below is bounded by a STRUCTURE - a numbered section of the
 * migration up to the next one, a dollar-quoted block, a branch from its own
 * discriminator to its own refusal - and never by a byte count. See
 * tests/helpers/sourceWindow.ts for why that is not a style preference.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sliceBetween, sliceDollarQuoted } from './helpers/sourceWindow';

const MIGRATIONS = resolve(__dirname, '..', 'supabase', 'migrations');

const file = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith('_the_diamond_seat_guards_know_a_tournament_seat.sql'))
  .sort()
  .at(-1);
if (!file) throw new Error('the tournament seat guard migration is missing');

const MIG = readFileSync(join(MIGRATIONS, file), 'utf8');

/**
 * Comments carry no behaviour. This migration's header and its injected
 * commentary discuss every string the assertions look for - including the word
 * "stack", repeatedly, in prose explaining that a tournament seat has nothing
 * to do with one. An assertion that read the prose as if it were the rule is
 * exactly the mistake sourceWindow.ts was written about.
 */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** Each numbered section runs until the next one starts. */
const section = (from: string, to: string) => sliceBetween(MIG, from, to);

const ADMIT = section('-- 1. THE ADMISSION GUARD', '-- 2. THE BINDER');
const BINDER = section('-- 2. THE BINDER', '-- 3. THE COMMIT-TIME INVARIANT');
const INVARIANT = section(
  '-- 3. THE COMMIT-TIME INVARIANT',
  '-- 4. THE REPLACEMENT FOR THE ACCIDENT'
);
const ENTRY_RULE = section(
  '-- 4. THE REPLACEMENT FOR THE ACCIDENT',
  '-- 5. EVERY GUARD TOUCHED HERE IS WATCHED'
);
const WATCHED = section(
  '-- 5. EVERY GUARD TOUCHED HERE IS WATCHED',
  '-- 6. THE CASH RULE SURVIVED'
);
const VERIFY = sliceBetween(MIG, '-- 6. THE CASH RULE SURVIVED', 'COMMIT;');

/** The new trigger function, from its own dollar tag to its own closing tag. */
const ENTRY_FN = code(sliceDollarQuoted(ENTRY_RULE, '$fn$'));

/**
 * The tournament branch of a guard, from the branch's own discriminator to its
 * own refusal. It grows exactly as fast as the branch does.
 */
const ADMIT_TOURNAMENT = code(sliceBetween(ADMIT, "c.purpose='tournament_entry'", 'P0811'));
const INVARIANT_TOURNAMENT = code(sliceBetween(INVARIANT, 't.tournament_id IS NOT NULL', 'P0812'));

describe('LAW: a tournament stack is not a Diamond', () => {
  describe('the stack is a play unit and is never tied to custody', () => {
    it('admits a tournament seat by a funded live entry, not by an amount', () => {
      const t = code(ADMIT);
      expect(t).toContain(
        "c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL"
      );
      expect(t).toContain('a.tournaments_enabled');
      expect(t).toContain('Diamond Tournament Seat Requires A Funded Entry');
    });

    it('never compares a stack to custody in the admission branch', () => {
      // The window is the branch itself, so a comparison added anywhere inside
      // it is caught however long the branch grows.
      expect(ADMIT_TOURNAMENT.length).toBeGreaterThan(0);
      expect(ADMIT_TOURNAMENT).not.toMatch(/stack/i);
    });

    it('never compares a stack to custody in the commit-time arm', () => {
      expect(INVARIANT_TOURNAMENT.length).toBeGreaterThan(0);
      expect(INVARIANT_TOURNAMENT).not.toMatch(/stack/i);
      // What it DOES require is coverage: a live seat, a live funded entry.
      expect(INVARIANT_TOURNAMENT).toContain("c.purpose='tournament_entry'");
      expect(INVARIANT_TOURNAMENT).toContain("c.state='active'");
    });

    it('binds a tournament entry to the entry and never to a seat', () => {
      // The window is the replacement block itself - the text that becomes the
      // binder - so it says what the FUNCTION will hold, not what the migration
      // happens to quote. The section also carries the anchor it replaces, and
      // that copy is the old text, not the new rule.
      const t = code(sliceDollarQuoted(BINDER, '$r$'));
      // Exactly one seat binding is written, and it is the cash one: the
      // tournament branch returns before it is reached.
      expect(t.match(/SET seat_id=/g) ?? []).toHaveLength(1);
      expect(t).toContain('Diamond Tournament Seat Requires A Funded Entry');
      // A tournament entry is asserted, then left exactly as the entry door
      // left it - which is what lets it survive a move, a balance and a re-seat.
      expect(t).toMatch(
        /tournament_id FROM public\.tables t WHERE t\.id=NEW\.table_id\) IS NOT NULL/
      );
      // And the migration proves the same thing against the live definition.
      expect(code(VERIFY)).toContain("replace(v_bind, 'SET seat_id=', '')");
    });

    it('lets a tournament seat move inside its event and nowhere else', () => {
      // The deleted TG_OP<>'INSERT' used to forbid every move. Balancing is how
      // a tournament is dealt, so the move is allowed - and a move that carried
      // one event's paid entry onto another event's felt is refused by name.
      const t = code(ADMIT);
      expect(t).toContain('A Diamond Tournament Seat Moves Only Inside Its Own Tournament');
      expect(t).toMatch(/t\.id=OLD\.table_id[\s\S]*IS DISTINCT FROM[\s\S]*t\.id=NEW\.table_id/);
    });
  });

  describe('the entry custody is the entry, and play cannot move it', () => {
    it('refuses a tournament entry that carries any seat binding', () => {
      expect(ENTRY_FN).toContain('A Diamond Tournament Entry Never Binds To A Seat');
      expect(ENTRY_FN).toMatch(
        /NEW\.seat_id IS NOT NULL OR NEW\.seat_joined_at IS NOT NULL OR NEW\.occupancy_id IS NOT NULL/
      );
    });

    it('holds exactly what its recorded movements reserved for it', () => {
      // A movement is written only by the reserve and release doors, each of
      // which journals the wallet. A balance that PLAY produced has no movement
      // behind it, so the transaction aborts.
      expect(ENTRY_FN).toContain('poker_diamond_movements');
      expect(ENTRY_FN).toMatch(/action='reserve' THEN m\.amount ELSE -m\.amount/);
      expect(ENTRY_FN).toContain('A Diamond Tournament Entry Holds Only What Was Reserved For It');
      expect(ENTRY_FN).toMatch(/NEW\.balance IS DISTINCT FROM v_moved/);
    });

    it('is fixed to the player and the event it paid for', () => {
      expect(ENTRY_FN).toContain(
        'A Diamond Tournament Entry Is Fixed To The Player And Event It Paid For'
      );
      for (const col of ['user_id', 'target_id', 'arena_id', 'entry_key', 'purpose']) {
        expect(ENTRY_FN).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
      }
    });

    it('is armed as a deferred constraint trigger and is closed to a browser', () => {
      const t = code(ENTRY_RULE);
      expect(t).toMatch(
        /CREATE CONSTRAINT TRIGGER zzz_diamond_entry_custody_is_the_entry[\s\S]*AFTER INSERT OR UPDATE ON public\.poker_diamond_custody DEFERRABLE INITIALLY DEFERRED/
      );
      expect(t).toMatch(
        /REVOKE ALL ON FUNCTION public\.fn_poker_diamond_entry_custody_is_the_entry\(\)\s*\n?\s*FROM PUBLIC,anon,authenticated/
      );
    });

    it('refuses rather than repairs', () => {
      // 10.11 and 10.12: the replacement for the accident is a refusal on the
      // live path, never a sweep, a backfill or a reconciler.
      const t = code(ENTRY_RULE);
      expect(t).not.toMatch(/_repair_|_backpay_|_redrive_|_sweep_|_catchup_|_heal_|_backfill_/i);
      expect(t).not.toMatch(/cron\.schedule/i);
      expect(t).toMatch(/RAISE EXCEPTION/);
    });
  });

  describe('the cash equation is untouched', () => {
    it('keeps stack = balance on a cash seat at all three guards', () => {
      expect(code(ADMIT)).toContain('c.balance=NEW.stack');
      const inv = code(INVARIANT);
      expect(inv).toContain('s.stack=c.balance');
      expect(inv).toContain('c.balance=s.stack');
      // The binder slices its WHOLE cash statement, terminator included, so the
      // equation is visible here and provable against the live definition.
      expect(code(sliceDollarQuoted(BINDER, '$r$'))).toContain('balance=NEW.stack');
      expect(code(VERIFY)).toContain("position('balance=NEW.stack' in v_bind) = 0");
    });

    it('keeps a cash seat unable to move tables', () => {
      expect(code(ADMIT)).toContain("TG_OP<>'INSERT'");
    });

    it('keeps the cash switch and the cash refusals', () => {
      expect(code(ADMIT)).toContain('a.cash_games_enabled');
      expect(code(ADMIT)).toContain('Diamond Seat Requires Atomic Custody Funding');
      expect(code(BINDER)).toContain('diamond_seat_custody_binding_failed');
      expect(code(INVARIANT)).toContain('diamond_seat_and_custody_must_commit_together');
    });

    it('asserts the cash rule survived, in the migration itself', () => {
      const t = code(VERIFY);
      expect(t).toContain('the cash admission rule was disturbed');
      expect(t).toContain('the cash binding was disturbed');
      expect(t).toContain('the cash seat/custody equation was disturbed');
    });
  });

  describe('every new refusal names itself', () => {
    it('gives each one its own message and its own SQLSTATE', () => {
      const refusals: Array<[string, string]> = [
        ['Diamond Tournament Seat Requires A Funded Entry', 'P0810'],
        ['A Diamond Tournament Seat Moves Only Inside Its Own Tournament', 'P0811'],
        ['A Diamond Tournament Seat Must Hold Its Funded Entry', 'P0812'],
        ['A Diamond Tournament Entry Never Binds To A Seat', 'P0813'],
        ['A Diamond Tournament Entry Holds Only What Was Reserved For It', 'P0814'],
        ['A Diamond Tournament Entry Is Fixed To The Player And Event It Paid For', 'P0815'],
      ];
      for (const [message, code_] of refusals) {
        const at = MIG.indexOf(`RAISE EXCEPTION '${message}'`);
        expect(at, `${message} is not raised`).toBeGreaterThan(-1);
        // The code belongs to THIS raise: the window is the statement, from the
        // raise to the semicolon that ends it.
        const stmt = MIG.slice(at, MIG.indexOf(';', at) + 1);
        expect(stmt, `${message} does not carry ${code_}`).toContain(`ERRCODE='${code_}'`);
      }
      const codes = refusals.map(([, c]) => c);
      expect(new Set(codes).size).toBe(codes.length);
      // And none of them is the cash guards' SQLSTATE, so a Diamond tournament
      // refusal can never be read as an unrelated check violation.
      expect(codes).not.toContain('23514');
    });

    it('capitalises every word and uses no em dash', () => {
      // CLAUDE.md section 5 rule 7. These reach a player as a popup.
      for (const m of code(MIG).match(/RAISE EXCEPTION 'A?n? ?Diamond[^']*'/g) ?? []) {
        expect(m).not.toContain('—');
      }
      expect(code(MIG)).not.toContain('—');
    });
  });

  describe('the guards that decide this are watched', () => {
    it('puts all three seat guards and the entry rule on the watchlist', () => {
      const t = WATCHED;
      for (const name of [
        'fn_poker_guard_chip_seat',
        'fn_poker_bind_diamond_seat',
        'fn_poker_diamond_entry_custody_is_the_entry',
        'fn_poker_diamond_seat_keeps_custody',
      ]) {
        expect(t).toContain(`'${name}'`);
      }
      expect(t).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()');
    });

    it('declares every baseline it moves, in the same transaction', () => {
      expect(WATCHED).toContain('fn_ca_declare_guard_redefinition');
      expect(WATCHED).toContain("'migration the_diamond_seat_guards_know_a_tournament_seat'");
      expect(code(VERIFY)).toContain('widening the watchlist dropped');
    });

    it('is one migration in one transaction', () => {
      expect(MIG.match(/^BEGIN;$/gm) ?? []).toHaveLength(1);
      expect(MIG.match(/^COMMIT;$/gm) ?? []).toHaveLength(1);
    });
  });

  describe('it opens nothing', () => {
    it('leaves both arena switches exactly where it found them', () => {
      const t = code(MIG);
      expect(t).not.toMatch(/SET\s+tournaments_enabled/i);
      expect(t).not.toMatch(/tournaments_enabled\s*=\s*true/i);
      expect(t).not.toMatch(/SET\s+cash_games_enabled/i);
      expect(t).not.toMatch(/cash_games_enabled\s*=\s*(true|false)/i);
    });

    it('writes no custody row and moves no money', () => {
      const t = code(MIG);
      expect(t).not.toMatch(/INSERT INTO public\.poker_diamond_custody/i);
      expect(t).not.toMatch(/INSERT INTO public\.poker_diamond_movements/i);
      expect(t).not.toMatch(/UPDATE public\.profiles/i);
      // The migration asserts the estate it believed it was changing.
      expect(t).toContain("public.poker_diamond_custody WHERE purpose='tournament_entry'");
    });

    it('writes no horse branch', () => {
      // CLAUDE.md 10.5. A horse registers, is seated and is paid identically.
      expect(code(MIG)).not.toMatch(/is_horse/i);
    });
  });
});
