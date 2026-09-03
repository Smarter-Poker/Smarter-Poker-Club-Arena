/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SPIN TREASURY IS FUNDED AT THE LAST SEAT, AND THE SEAT HOLDS ITS CHIPS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-01, verbatim, in two parts:
 *
 *   "after all 3 buy ins are paid for, rake is taken out and sent to the rake
 *    treasury, and all remaining funds from the buy in goes to the [spins]
 *    treasury, in real time as soon as the 3rd buy in is paid for."
 *
 *   "we used to award more chips depending on if its a higher multiplier... we
 *    are no longer doing that, once a player sits down and 'buys in' they
 *    either get 300 chips for a turbo, or 1000 chips for a deep stack. as soon
 *    as they buy in 300 chips should appear in their action box (not 0)."
 *
 * The two are one change. A stack that depended on the multiplier could not be
 * known when the money left the wallet, so the seat was written at zero and the
 * real number arrived on the chip-drop beat ~14.8s later. Moving the stack to
 * the board is what makes an honest seat possible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SPIN_STACKS, SPIN_SPEED_LABELS, SPIN_TIERS } from '../config/spinSpec.js';

const ROOT = join(__dirname, '..', '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

/* The board configs are asserted from SOURCE, not imported. Importing
   TournamentRecurringService constructs the Supabase client at module load and
   aborts the run with FATAL: SUPABASE_SERVICE_ROLE_KEY is not set. */
const RECURRING = readFileSync(join(__dirname, 'TournamentRecurringService.ts'), 'utf8');

const migration = (needle: string): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(needle));
  if (!file) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, file), 'utf8');
};

describe('the board decides the stack', () => {
  it('crosses both depths with every stake and game type', () => {
    expect(RECURRING).toContain("const SPIN_BOARD_SPEEDS: SpinSpeed[] = ['turbo', 'deep']");
    expect(RECURRING).toContain('SPIN_BOARD_SPEEDS.flatMap((speed)');
    expect(RECURRING).toContain('startingStack: SPIN_STACKS[speed]');
  });

  it('uses only the two depths Dan named, and not the retired 5000 band', () => {
    expect(SPIN_STACKS).toEqual({ turbo: 300, deep: 1000 });
    expect(Object.values(SPIN_STACKS)).not.toContain(5000);
  });

  it('the tier table decides nothing about chips', () => {
    for (const tier of SPIN_TIERS) {
      expect((tier as unknown as Record<string, unknown>).startingStack).toBeUndefined();
    }
  });

  it('the creation path takes the stack from the board, not from a tier', () => {
    expect(RECURRING).toContain('const spinStack = config.startingStack');
    expect(RECURRING).not.toMatch(/const spinStack = placeholderTier\.startingStack/);
  });

  it('names the deep boards so a player can tell them apart', () => {
    expect(SPIN_SPEED_LABELS.deep).toBe('Deep Stack');
    expect(SPIN_SPEED_LABELS.turbo).toBe('Turbo');
    expect(RECURRING).toContain('${SPIN_SPEED_LABELS[speed]} Spin');
  });

  it('leaves the turbo names alone, because a rename orphans 32 open boards', () => {
    // ensureBoardOpen identifies a board by its config NAME. Renaming the
    // existing 32 would open 32 more and strand the old ones in REGISTERING.
    expect(RECURRING).toContain("speed === 'turbo'");
    expect(RECURRING).toContain('${buyIn} Chip Spin ${v.label}');
  });
});

describe('the treasury is funded by the seat that fills the board', () => {
  const entry = migration('the_spin_treasury_is_funded_when_the_last_seat_is_paid');
  const fix = migration('the_entry_booking_lock_took_the_wrong_argument_types');
  const settle = migration('settle_books_the_prize_the_entry_books_the_buy_ins');

  it('books the rake to the rake treasury and the remainder to the pool', () => {
    expect(entry).toContain('INSERT INTO public.rake_records');
    expect(entry).toContain('UPDATE public.spin_bonus_pools');
    expect(entry).toMatch(/v_reserve_in\s*:=\s*round\(v_collected - v_rake, 2\)/);
  });

  it('hangs off the seat count, so a horse funds it exactly as a human does', () => {
    // CLAUDE.md 10.5. Both fn_take_seat_and_buy_in and
    // fn_seat_horse_in_seat_first_game call the counter; neither is named here.
    expect(settle).toContain('fn_sync_seat_first_player_count');
    expect(fix).toContain('fn_spin_book_entry(p_tournament_id)');
  });

  it('is idempotent on its own ledger row, not on a flag', () => {
    expect(entry).toContain("kind = 'contribution'");
    expect(entry).toContain('already_booked');
  });

  it('settle keys on the prize row alone, or the entry row would skip it', () => {
    // The contribution now exists before the wheel turns. A guard that treated
    // it as "settled" would take the buy-ins and never book the payout.
    expect(settle).toContain("kind = 'jackpot_draw'");
    expect(settle).toContain('v_entry_booked');
    expect(settle).toContain('v_rake_booked');
  });

  it('files a booking failure instead of warning into the void', () => {
    // The first cut of this hook raised 42883 on every call - the advisory
    // lock took an overload that does not exist - and a RAISE WARNING hid it
    // completely while 721 Spins went on booking at settle.
    expect(fix).toContain('ca_drift_incidents');
    expect(fix).toContain("pg_advisory_xact_lock(hashtextextended('spin_entry:'");
  });
});

describe('a paid seat is never shown holding nothing', () => {
  const seat = migration('the_seat_holds_its_chips_from_the_moment_it_is_paid_for');

  it('the human seat is written with the board stack', () => {
    expect(seat).toContain('v_stack := COALESCE(v_t.starting_chips, 0)');
    expect(seat).toContain('SET user_id = v_uid, stack = v_stack');
  });

  it('the horse seat is written with the same number', () => {
    expect(seat).toContain('fn_seat_horse_in_seat_first_game');
    expect(seat).toMatch(/stack\s*=\s*v_stack/);
  });

  it('neither path can go back to seating at zero', () => {
    expect(seat).toContain('still seats a player at zero chips');
    expect(seat).toContain('still seats a horse at zero chips');
  });
});
