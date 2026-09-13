/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A PAID ENTRANT HAS A SEAT AND CHIPS, AND NOBODY BUSTS AT ZERO
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23 (verbatim): "I REGISTERED FOR A TOURNAMENT DURING LATE
 * REGISTRATION... IT TOOK ME TO THE PAGE, BUT DIDN'T SIT ME, GIVE ME CHIPS OR
 * ANYTHING... THE TOURNAMENT ISN'T EVEN RUNNING."
 *
 * Four faults sat behind that one sentence. This suite pins all four shut.
 *
 * 1. REGISTRATION DID NOT SEAT. fn_register_for_tournament inserted a
 *    'registered' row at 0 chips with table_id NULL and stopped — correct
 *    before a tournament starts, useless during one, because the start() that
 *    would have seated him already ran hours ago.
 *
 * 2. THE CLIENT PAPERED OVER IT. Finding table_id null, the hook navigated to
 *    an arbitrary table of that tournament, landing the player on somebody
 *    else's felt as a spectator.
 *
 * 3. THE FOOTER GAVE AN IMPOSSIBLE INSTRUCTION. "Spectating, Tap An Open Seat
 *    To Join" — at a table where `canSit` is false for every seat, so each one
 *    renders as an inert div with no click handler.
 *
 * 4. THE BUST SWEEP ENDED GAMES THAT NEVER STARTED. A Spin seats its field as
 *    reservations at 0 chips and credits the stacks ~18s later, after the
 *    wheel. The elimination checker runs every 5s, so its first pass read the
 *    whole field at `chips <= 0`, busted all but an arbitrary "top" stack, and
 *    paid that player first prize. Production, 2026-08-23: 276 of the last 278
 *    completed Spins had ZERO rows in hand_history. Every one collected
 *    buy-ins and paid a prize for a game in which no card was ever dealt.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceEnclosingBlock, sliceMethod } from '../helpers/sourceWindow';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const BASE = strip(read('server/src/tournament/TournamentManagerBase.ts'));
const ELIM = strip(read('server/src/tournament/TournamentManagerEliminations.ts'));
const HOOK = strip(read('src/hooks/useTournamentRegistration.ts'));
const TABLE_PAGE = strip(read('src/pages/TablePage.tsx'));
const MIGRATION = read('supabase/migrations/20260823270000_late_registration_takes_a_seat.sql');

describe('registration seats the late entrant, in the same transaction as the debit', () => {
  it('there is a function whose whole job is putting a late entrant in a seat', () => {
    expect(MIGRATION).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_seat_late_registrant/);
  });

  it('it only ever acts on a tournament that is already RUNNING', () => {
    // Anything not RUNNING is start()'s to seat. Seating a pre-start entrant
    // here would put him on a table the start path is about to build again.
    expect(MIGRATION).toMatch(/IF v_status IS DISTINCT FROM 'RUNNING' THEN/);
    expect(MIGRATION).toMatch(/'reason', 'not_running'/);
  });

  it('it refuses to touch a player who already holds a seat', () => {
    // Re-seating a seated player is how duplicate seat rows get made.
    expect(MIGRATION).toMatch(/AND table_id IS NULL/);
    expect(MIGRATION).toMatch(/'reason', 'already_seated_or_missing'/);
  });

  it('the stack is the real starting stack, and the early-bird bonus is ADDED to it', () => {
    // Overwriting `chips` with starting_chips is the mistake that silently
    // destroyed every early-bird bonus ever granted before 2026-08-22.
    expect(MIGRATION).toMatch(/v_chips := v_start_chips \+ GREATEST\(v_bonus, 0\)/);
  });

  it('a vacated seat row is REUSED before a new one is inserted', () => {
    // table_seats carries UNIQUE (table_id, seat_number) with no left_at
    // predicate, so a blind INSERT onto a seat somebody has left raises 23505
    // every single time — which is what made the TypeScript sweep skip some
    // players forever.
    const fn = MIGRATION.slice(MIGRATION.indexOf('fn_seat_late_registrant'));
    expect(fn).toMatch(/UPDATE public\.table_seats[\s\S]{0,500}left_at IS NOT NULL/);
    expect(fn).toMatch(/IF NOT FOUND THEN[\s\S]{0,300}INSERT INTO public\.table_seats/);
    expect(fn).toMatch(/EXCEPTION WHEN unique_violation/);
  });

  it('the seat and the roster row are written together, never one without the other', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('fn_seat_late_registrant'));
    expect(fn).toMatch(
      /UPDATE public\.tournament_players[\s\S]{0,300}status\s*=\s*'playing'[\s\S]{0,300}table_id\s*=\s*v_table/
    );
  });

  it('a full field is a refusal, not an invented tenth seat', () => {
    // The entrant stays 'registered', which is exactly what
    // checkDynamicTableExpansion counts — a table spawns and the sweep seats
    // him. Squeezing a tenth player onto a nine-handed table would be worse
    // than waiting five seconds.
    expect(MIGRATION).toMatch(/'reason', 'no_open_seat'/);
  });

  it('registration calls it, and only on the late-registration branch', () => {
    expect(MIGRATION).toMatch(
      /IF v_late_open THEN\s*\n\s*v_seat := public\.fn_seat_late_registrant\(p_tournament_id, v_uid\);/
    );
  });

  it('the rewritten registration function kept every money and capacity gate', () => {
    // The body is reproduced verbatim from production; this is the guard
    // against a re-paste that quietly loses one of them.
    for (const gate of [
      'atomic_deduct_wallet_and_log',
      'log_wallet_transaction',
      'rake_records',
      'credit_player_wallet',
      "'already_registered'",
      "'tournament_full'",
      "'insufficient_balance'",
      "'registration_closed'",
      "'not_authorized_to_register'",
      "'vip_only'",
    ]) {
      expect(MIGRATION, `registration lost the ${gate} gate`).toContain(gate);
    }
  });

  it('the migration asserts its own wiring after applying', () => {
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'fn_register_for_tournament does not call/);
    expect(MIGRATION).toMatch(/lost a money or capacity gate/);
  });
});

describe('the client sends a paid entrant to his own seat, or to his own tournament', () => {
  it('it no longer dumps him on an arbitrary table of that tournament', () => {
    // THE bug. `.from('tables').eq('tournament_id', ...)` picked a stranger's
    // felt and navigated there because the entrant had no seat of his own.
    expect(HOOK).not.toMatch(/from\('tables'\)/);
    expect(HOOK).not.toMatch(/neq\('status', 'closed'\)/);
  });

  it('it looks for HIS seat, and retries while the server assigns one', () => {
    expect(HOOK).toMatch(/const findMySeat = async/);
    expect(HOOK).toMatch(/attempt < SEAT_LOOKUP_RETRIES/);
  });

  it('the retry is bounded, so a stuck seat cannot hang the button forever', () => {
    const retries = Number(/SEAT_LOOKUP_RETRIES = (\d+)/.exec(HOOK)?.[1]);
    const delay = Number(/SEAT_LOOKUP_RETRY_MS = (\d+)/.exec(HOOK)?.[1]);
    expect(retries).toBeGreaterThan(0);
    expect(retries).toBeLessThanOrEqual(5);
    expect(retries * delay).toBeLessThanOrEqual(8000);
  });

  it('with no seat he lands on his tournament and is told the seat is coming', () => {
    expect(HOOK).toMatch(/navigate\(`\/tournaments\/\$\{t\.id\}`\)/);
    expect(HOOK).toMatch(/Your Seat Is Being Assigned/);
  });

  it('with a seat he lands on it', () => {
    expect(HOOK).toMatch(/navigate\(`\/table\/\$\{seatTableId\}`\)/);
  });
});

describe('the felt never gives an instruction it will refuse', () => {
  it('a registered-but-unseated viewer is told his seat is coming', () => {
    expect(TABLE_PAGE).toMatch(/awaitingTournamentSeat/);
    expect(TABLE_PAGE).toMatch(/You Are Registered, Your Seat Is Being Assigned/);
  });

  it('that state is read from the roster, not guessed from the seats', () => {
    // Every seat-derived signal says "spectator" for a late entrant. Only
    // tournament_players knows he has paid.
    expect(TABLE_PAGE).toMatch(/from\('tournament_players'\)/);
    expect(TABLE_PAGE).toMatch(/setAwaitingTournamentSeat\(/);
  });

  it('a plain spectator at an MTT is not told to tap a seat that cannot be tapped', () => {
    // canSit is false for every seat of a non-seat-first tournament table, so
    // "Tap An Open Seat To Join" was an instruction the same screen refused.
    expect(TABLE_PAGE).toMatch(/tableState\.isTournament && !seatFirstBuyIn/);
  });

  it('a cash table still gets the invitation, because its seats really are tappable', () => {
    expect(TABLE_PAGE).toMatch(/'Spectating, Tap An Open Seat To Join'/);
  });
});

describe('nobody busts from a fabricated zero-stack field', () => {
  it('no manager owns a sweep interval or a delayed-credit bust gate', () => {
    expect(BASE).not.toMatch(/POST_CREDIT_BUST_SLACK_MS/);
    expect(BASE).not.toMatch(/bustingArmedAt/);
    expect(ELIM).not.toMatch(/setInterval\(/);
    expect(ELIM).toMatch(/registerEliminationScheduler/);
  });

  it('the elimination path contains no delayed-credit repair branch', () => {
    expect(ELIM).not.toMatch(/bustingArmedAt/);
    expect(ELIM).not.toMatch(/stacks not credited yet/i);
  });

  it('a whole field reading zero chips is refused OUTRIGHT, timer or no timer', () => {
    /**
     * The independent invariant, and the one that matters most. Chips are
     * conserved: every chip one player loses another gains, so the sum of live
     * stacks is constant and cannot be zero while anybody is still playing.
     * "every remaining player is at <= 0" is therefore not a state poker can
     * produce — it can only mean the stacks were never written. A restart
     * inside the reveal window rearms no timer, and a broken seat sync is not
     * on a timer at all, so this guard cannot be folded into the one above.
     *
     * (2026-09-11) The guard now reads the same `status='playing'` count the
     * ladder seed uses - one round trip instead of two identical ones - so
     * the count it compares against is `playingCount`.
     */
    expect(ELIM).toMatch(/busted\.length >= playingCount/);
    expect(ELIM).toMatch(/zero_chip_field_refused/);
  });

  it('the old behaviour — spare one zero, bust the rest, pay first prize — is unreachable', () => {
    // The `playingCount === busted.length` branch may still slice the top
    // stack for a genuine all-in showdown, but it can no longer be reached
    // with an all-zero field, because the invariant returns before it.
    const sweep = ELIM.slice(ELIM.indexOf('startEliminationChecker'));
    const zeroGuard = sweep.indexOf('busted.length >= playingCount');
    const spareTop = sweep.indexOf('bustedOrdered.slice(0, -1)');
    expect(zeroGuard).toBeGreaterThan(-1);
    expect(spareTop).toBeGreaterThan(-1);
    expect(zeroGuard).toBeLessThan(spareTop);
  });

  it('resume has no authority to mint or repair stacks', () => {
    const resume = sliceMethod(BASE, 'private async resumeLifecycle(');
    expect(resume).not.toMatch(/creditSeatStacks/);
    expect(resume).not.toMatch(/\.update\(\{\s*stack:/);
  });
});

describe('a tournament table reports the level and blinds it is actually playing', () => {
  it('a tournament trusts its own live blind columns over the frozen `stakes` string', () => {
    // `stakes` is written once at table creation as the LEVEL-1 blinds and
    // advanceBlindLevel never touched it again. Preferring it pinned every
    // tournament table to its opening level for life — and since each seat's
    // depth badge is stack / safeBB(blinds), every stack was displayed at the
    // wrong depth by the full ratio between level 1 and the live level.
    expect(TABLE_PAGE).toMatch(
      /\(table\.game_type === 'tournament' \|\| !!table\.tournament_id\) &&/
    );
  });

  it('the engine keeps `stakes` in step on every level-up', () => {
    const upd = sliceEnclosingBlock(BASE, 'const safeSmallBlind');
    expect(upd).toMatch(/stakes: `\$\{safeSmallBlind\}\/\$\{safeBigBlind\}`/);
  });

  it('blind_structure is PARSED, not cast — it is a text column of JSON', () => {
    // The raw cast made `blindStructure` an ~800-character STRING whose
    // `.length > 0` passed and whose `[8]` was the ninth CHARACTER, so the
    // level guard never fired and the masthead printed its `|| 1` fallback.
    expect(TABLE_PAGE).toMatch(/parseBlindStructure\(tournData\.blind_structure\)/);
    expect(TABLE_PAGE).not.toMatch(/tournData\.blind_structure as Array</);
  });

  it('the level number is set unconditionally, not only when the blind table parses', () => {
    expect(TABLE_PAGE.indexOf('const tableHasLiveBlinds')).toBeGreaterThan(-1);
    expect(sliceEnclosingBlock(TABLE_PAGE, 'const tableHasLiveBlinds')).toMatch(/currentLevel,/);
  });
});
