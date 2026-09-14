/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A TOURNAMENT CHIP GRANT CANNOT MINT (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ca_drift_incidents 8b8fe26c had been open since 2026-09-09 and had fired 43
 * times. Two RUNNING tournaments held more chips than they ever issued:
 * 7aa16fa7 "$100 Freeroll - 12:00 PM" +10,000 on a 2,505,000 supply, and
 * a5aa6984 "Early Bird Freeroll (NLH)" +2,500 on 317,500. Both overages are
 * exact multiples of the event's own starting stack, which is the signature of
 * a GRANT and not of play: play moves chips between seats and cannot change
 * the total.
 *
 * The class - a tournament seat funded from the tournament_players.chips
 * MIRROR instead of from the felt - was found and fixed on 2026-09-10 inside
 * fn_ca_assign_tournament_player_seat_locked, which also gained a
 * per-assignment conservation gate. What that work did not cover, and what
 * this law is about, is the OTHER way chips enter a tournament.
 *
 * Chips can only enter two ways: a live seat appears holding chips, or an
 * existing seat's stack is raised.
 *
 *   - a seat APPEARING is forced through a canonical RPC by the
 *     a0_tournament_live_seat_root_guard trigger, and both such RPCs conserve
 *     (the assignment gate; fn_move_tournament_player zeroes its source);
 *   - a stack being RAISED is NOT covered by that trigger, which fires on
 *     INSERT and on UPDATE OF table_id/user_id/seat_number/left_at and never
 *     on stack. The one statement that deliberately raises a tournament seat
 *     stack is fn_ca_process_tournament_chip_purchase_money_v1 - rebuy,
 *     re-entry and add-on - and it had NO conservation check of any kind.
 *
 * So the door where chips are BOUGHT was the one door with nothing checking
 * how many chips existed afterwards. Guarding one door at a time is how this
 * incident happened, so the rule is written ONCE, in
 * fn_ca_assert_tournament_chip_grant, for every future door to call.
 *
 * THE INVARIANT: sum(live table_seats.stack) <= chips the roster has bought.
 * True at every instant, mid-hand included - chips in a pot have left the
 * stacks, so the felt can be at or below the supply but never above it. An
 * existing overage is tolerated and only GROWTH is refused, the same shape as
 * the 2026-09-10 gate and this estate's NOT VALID constraints.
 *
 * WHAT MUST NOT HAPPEN TO THIS LAW. The cheap way to make the alarm stop is
 * p_tolerance_per_player. That is pinned below at its default of 1 precisely
 * so that raising it to hide a mint turns this test red.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const SQL = read('supabase/migrations/20260911145935_a_tournament_chip_grant_cannot_mint.sql');

/** Exactly one function's shipped text: from its CREATE to its closing $function$. */
const fnBody = (name: string): string => {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} is not in the migration`).toBeGreaterThan(-1);
  const end = SQL.indexOf('$function$;', start);
  expect(end, `${name} has no closing $function$`).toBeGreaterThan(start);
  return SQL.slice(start, end);
};

describe('the rule exists in exactly one place', () => {
  it('a single function decides whether a grant would mint', () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_assert_tournament_chip_grant/);
    expect(SQL).toMatch(/TOURNAMENT_CHIP_GRANT_WOULD_MINT/);
  });

  it('it refuses growth past the supply and tolerates an overage it inherited', () => {
    // v_after > v_felt is the growth test; v_after > v_supply is the cap test.
    // BOTH are required, so an event already over its cap keeps playing.
    expect(SQL).toMatch(/IF v_after>v_felt AND v_after>v_supply THEN/);
  });

  it('the supply is spelled the way the GRANT spells it, not the way a reader would guess', () => {
    // fn_ca_process_tournament_chip_purchase_money_v1 resolves its grant as
    // COALESCE(NULLIF(rebuy_chips,0), starting_chips, 0). A checker that
    // models it as COALESCE(rebuy_chips,0) accuses a correct grant of drift.
    expect(SQL).toMatch(/COALESCE\(NULLIF\(t\.rebuy_chips,0\),t\.starting_chips,0\)/);
    expect(SQL).toMatch(/COALESCE\(NULLIF\(t\.addon_chips,0\),t\.starting_chips,0\)/);
  });
});

describe('the chip-purchase door calls it', () => {
  // BOUNDED to the function body. An unbounded slice runs to end of file and
  // picks up section 6's self-test, which calls the same guard - so a money
  // core that had LOST the call still looked as though it carried one.
  const core = fnBody('fn_ca_process_tournament_chip_purchase_money_v1');

  it('the money core asserts the grant', () => {
    expect(core).toMatch(/PERFORM public\.fn_ca_assert_tournament_chip_grant\(/);
  });

  it('and asserts BEFORE it writes the stack, not after', () => {
    // After the write, a RAISE still rolls back - but the assertion has to see
    // the intended value, and reading it back from the row it just wrote is
    // how a guard ends up agreeing with itself.
    const assertAt = core.indexOf('PERFORM public.fn_ca_assert_tournament_chip_grant(');
    const writeAt = core.indexOf('UPDATE public.table_seats\n       SET stack=CASE');
    expect(assertAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(writeAt);
  });

  it('a re-entry is refused while the entry still holds chips', () => {
    // The re-entry branch REPLACES the stack (stack = v_add) while the roster
    // gains rebuys + 1, so taken on a live stack it destroys those chips and
    // inflates the expected side in the same statement. The rebuy branch has
    // always guarded this ("Stack too high for a rebuy"); re-entry never did.
    expect(core).toMatch(/A Re-Entry Starts A New Stack And This Entry Still Holds % Chips/);
    expect(core).toMatch(/IF p_rebuy_type='reentry' AND COALESCE\(v_p\.chips,0\)>0 THEN/);
    // the guard it is modelled on must survive too
    expect(core).toMatch(/Stack too high for a rebuy/);
  });
});

describe('the checker and the guard cannot drift apart', () => {
  const checker = fnBody('fn_tournament_chip_conservation_check');

  it('the checker reads the SAME supply the guard enforces', () => {
    expect(checker).toMatch(/public\.fn_ca_tournament_chip_supply\(t\.id\)/);
    expect(checker).toMatch(/public\.fn_ca_tournament_felt_total\(t\.id\)/);
  });

  it('and no longer carries its own copy of the arithmetic', () => {
    expect(checker).not.toMatch(/l\.players \* l\.starting_chips/);
    expect(checker).not.toMatch(/rebuys \* l\.rebuy_chips/);
  });

  it('EVERY REGISTRANT IS DEALT IN survives: the count is the roster, not the seats', () => {
    expect(checker).toMatch(
      /SELECT count\(\*\) FROM public\.tournament_players tp\s*\n\s*WHERE tp\.tournament_id = t\.id\) AS players/
    );
    expect(checker).not.toMatch(/FROM public\.table_seats[\s\S]*AS players/);
  });

  it('THE TOLERANCE IS NOT THE FIX: it stays at one chip per player', () => {
    expect(checker).toMatch(/p_tolerance_per_player numeric DEFAULT 1/);
    expect(checker).toMatch(/> \(GREATEST\(p_tolerance_per_player, 0\) \* c\.players\)/);
  });
});

describe('the migration proves itself against production', () => {
  it('is one transaction, as the production DDL policy requires', () => {
    expect(SQL.match(/\nBEGIN;/g)?.length).toBe(1);
    expect(SQL.match(/\nCOMMIT;/g)?.length).toBe(1);
  });

  it('aborts if the shared supply changed any live expected value', () => {
    expect(SQL).toMatch(
      /ABORT: the shared chip supply disagrees with the previous inline arithmetic/
    );
  });

  it('aborts if either open finding stopped reporting its exact drift', () => {
    // Named amounts, so a later edit that quiets the alarm cannot apply.
    expect(SQL).toMatch(/COALESCE\(v_t1,-1\) <> 10000 OR COALESCE\(v_t2,-1\) <> 2500/);
  });

  it('proves the refusal against a real seat rather than asserting it in prose', () => {
    expect(SQL).toMatch(/selftest:noop/);
    expect(SQL).toMatch(/selftest:mint/);
    expect(SQL).toMatch(/ABORT: fn_ca_assert_tournament_chip_grant did not refuse a grant/);
  });
});

/**
 * The invariant restated as arithmetic, with this incident as its fixtures.
 * Anything that changes the SQL predicate above has to change these numbers
 * too, which is the point: the rule is small enough to state twice.
 */
const wouldMint = (feltNow: number, seatHoldsNow: number, newStack: number, supply: number) => {
  const after = feltNow - seatHoldsNow + newStack;
  return after > feltNow && after > supply;
};

describe('the invariant, on the numbers that opened the incident', () => {
  it('7aa16fa7 is already 10,000 over and may not get further over', () => {
    // the live seat holding 1,101,480 on a felt of 2,515,000, supply 2,505,000
    expect(wouldMint(2_515_000, 1_101_480, 1_101_480, 2_505_000)).toBe(false);
    expect(wouldMint(2_515_000, 1_101_480, 1_101_481, 2_505_000)).toBe(true);
  });

  it('a5aa6984 likewise, at +2,500 on 317,500', () => {
    expect(wouldMint(320_000, 320_000, 320_000, 317_500)).toBe(false);
    expect(wouldMint(320_000, 320_000, 322_500, 317_500)).toBe(true);
  });

  it('an ordinary rebuy inside the supply is not a mint', () => {
    // 100 entrants x 2,500 plus one rebuy just booked = 252,500 supply;
    // the buyer's seat goes 0 -> 2,500 on a felt of 250,000.
    expect(wouldMint(250_000, 0, 2_500, 252_500)).toBe(false);
  });

  it('but the same rebuy is refused when the roster never booked it', () => {
    expect(wouldMint(250_000, 0, 2_500, 250_000)).toBe(true);
  });

  it('a move that carries a stack unchanged is never a mint', () => {
    expect(wouldMint(250_000, 40_000, 40_000, 250_000)).toBe(false);
  });

  it('and a hand that redistributes chips is never a mint', () => {
    // winner 10,000 -> 18,000 while the losers already lost the 8,000
    expect(wouldMint(250_000, 18_000, 18_000, 250_000)).toBe(false);
  });
});
