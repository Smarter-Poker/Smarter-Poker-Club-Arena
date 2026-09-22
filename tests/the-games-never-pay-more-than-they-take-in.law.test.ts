/**
 * THE GAMES NEVER PAY MORE THAN THEY TAKE IN (Dan, 2026-09-08, BINDING)
 *
 * Dan: "Two alternates to the Diamond To Chip spinning wheel. A Plinko
 * version, 50x can be higher on this, but crash out pays nothing, and you
 * still need to maintain the 20% edge. And a Crash / Aviator-style: the
 * multiplier climbs until it crashes; cash out first. 50x can be higher, crash
 * out pays nothing, and you still need to maintain the 20% edge."
 *
 * Diamond Plinko and Diamond Crash
 * (supabase/migrations/20260908010241_plinko_and_crash_the_two_alternates_to_the_wheel.sql)
 * keep the edge and the never-pay-more promise by ARITHMETIC, the wheel's way:
 *
 *   - a bet is a whole number of chips; 0.80 of it is MINTED to the host
 *     through the declared issuance door (mint / issuance_reserve, registered
 *     by the chip_ledger issuance trigger), and the rest is retired diamonds:
 *     the house;
 *   - before a round the pool computes the largest multiplier it can promise
 *     on that bet: cap_fraction of its headroom (minted + this mint +
 *     allowance - paid - reserved), never above the ceiling, never above what
 *     the host bank holds beyond open reservations; the round is played
 *     against min(table, cap), and the cap is shown before the bet;
 *   - a plinko table is activated only when it returns exactly 0.800000 on the
 *     binomial weights C(16,k)/65536, and every launch table does;
 *   - the crash point is floor(80 * 2^48 / (r + 1)) cents floored at 1.00, so
 *     P(X >= x) = 0.8 / x for every target: cashing out ANYWHERE returns 80
 *     percent; an open round reserves bet x cap until it settles, and the
 *     server clock decides it, never the browser;
 *   - after every money move the pool re-checks
 *     paid + reserved <= minted + allowance and raises if the cap was bypassed;
 *   - the rate is the row (fn_ca_bridge_rate), horses are not filtered
 *     anywhere, and no repair job exists: time settling a decided round is
 *     the live path finishing its own work (CLAUDE.md 10.12).
 *
 * Every pin below is one of those. Weakening one re-opens a faucet.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { MAX_DIAMOND_SPIN, MIN_DIAMOND_SPIN } from '../src/utils/bonusGameBudget';
import {
  BONUS_PAYOUT_VERSION,
  PLINKO_DENOMINATIONS,
  PLINKO_LIVE_TABLES,
  PLINKO_MAX_DROPS,
  PLINKO_MIN_DROPS,
  PLINKO_TABLES,
  diamondBonusFloor,
  diamondBonusMinimum,
  plinkoDropChoices,
  plinkoTableForFloor,
  plinkoTableVersion,
  validBonusMinimum,
} from '../src/utils/diamondBonusPayout';
import {
  CHOICE_MODE,
  CHOICE_PAYOUT_VERSION,
  MINE_COUNTS,
  RANDOM_SPACE,
  ROAD_LADDERS,
  ROAD_LADDERS_V4,
  choose,
  minePrize,
  minePrizeV4,
  roadLadder,
  roadSurvives,
} from '../src/utils/diamondChoiceMath';
import {
  crashCashoutFloorCents,
  crashPointCentsFromRoll,
  crashPointFloorCents,
} from '../src/utils/diamondGamesFairness';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const files = readdirSync(DIR);

function latest(fragment: string): { name: string; sql: string } {
  const name = files
    .filter((f) => f.includes(fragment))
    .sort()
    .pop();
  expect(name, `no migration named like ${fragment}`).toBeTruthy();
  return { name: name as string, sql: readFileSync(resolve(DIR, name as string), 'utf8') };
}

function body(sql: string, fn: string): string {
  // A door whose signature changed is dropped and re-created, so it may be a
  // plain CREATE rather than CREATE OR REPLACE. Both are the same statement to
  // this law; read whichever one the migration used.
  const open = Math.max(
    sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`),
    sql.lastIndexOf(`CREATE FUNCTION public.${fn}(`)
  );
  expect(open, `${fn} has moved or gone`).toBeGreaterThan(-1);
  const start = sql.indexOf('$function$', open);
  const end = sql.indexOf('$function$', start + 10);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

const games = latest('plinko_and_crash_the_two_alternates_to_the_wheel');
const words = latest('the_ledger_learns_plinko_and_crash_prizes');
const opens = latest('the_wheel_opens_with_a_seeded_diamond_float');
/**
 * AMENDED 2026-09-10. Dan: "make sure that the chip payouts are 100% connected
 * and wired to the promo wallet and all diamonds taken in get credited to the
 * union owners wallet, or the club owners wallet." The law is unchanged - these
 * games still never pay out more than they take in - but the money it is stated
 * on moved: nothing is minted, the intake is the host owner's, and every payout
 * comes out of the host's promo wallet. Every body below is read from that
 * migration, which is the one that is live.
 */
const host = latest('the_games_belong_to_the_host');
/**
 * AMENDED AGAIN 2026-09-10. Dan: "the back up is the union or club main bank, if
 * the promo pool runs dry. wire that in." The promo wallet is still where every
 * payout comes from first; behind it now stands the host's own chip bank, and
 * COVER (the two together) is what every cap and gate is measured against.
 * Nothing is minted: the bank is a wallet the host already owns.
 */
const bank = latest('the_bank_backs_the_promo_wallet');
/**
 * AMENDED 2026-09-19 - THE SECOND HALF OF THE CONTRACT. Dan played twenty
 * 2,500-diamond Diamond Plinko awards, never cleared 21 chips, and never saw a
 * 5x, 10x or 20x. Nothing above was broken: every table returned exactly
 * 0.800000 on the binomial weights, no faucet was ever open, and the edge was
 * kept to the cent. The CALIBRATION was wrong, and a calibration is invisible
 * in a diff - the arithmetic that made the old game hopeless is arithmetic
 * nobody wrote down.
 *
 * At one to five diamonds a drop a 2,500-diamond award was 500 to 2,500 drops,
 * and the mean of that many drops IS the table's 0.80. Measured below off the
 * live table's own weights: the standard deviation of a 500-drop game's return
 * is 0.0997 of the entry and of a 2,500-drop game's 0.0446, so twice the entry
 * sat 12.0 and 26.9 standard deviations above the mean. A 1-in-65,536 top slot
 * was a label, not a prize, and no amount of correct edge arithmetic could make
 * it one.
 *
 * supabase/migrations/20260919220610_diamond_bonus_games_have_one_setting_and_super_guarantees_the_entry.sql
 * fixes it twice over: every Plinko game is exactly PLINKO_DROPS drops of a
 * tenth of the entry (the server refuses any other split), and the two open
 * tables carry real weight at the top. So this law now pins BOTH halves:
 *
 *   - the house edge, which was already here: exactly 0.80, by integer
 *     arithmetic, on every table and at every stopping point;
 *   - the calibration, which was not: both live tables top out at exactly
 *     20.00x with no dead slot, the ordinary table is reachable-rich measured
 *     exactly off the binomial weights, the exact distribution of a whole
 *     ten-drop game pays the entry back often enough to be a game, a Super
 *     batch clears its 1:1 guarantee through the multipliers themselves, no
 *     floor ever exceeds the expected return, each game has exactly one
 *     setting, and the SQL says what the client mirrors say.
 *
 * Weakening the first half re-opens a faucet. Weakening the second half
 * re-ships a game that cannot pay, which is the defect Dan actually found.
 * Every number below is computed from the exported constants, so a table
 * edited in src/ is measured, not merely re-described.
 */
const calib = latest('diamond_bonus_games_have_one_setting_and_super_guarantees_the_entry');

const CAP = body(host.sql, 'fn_diamond_game_cap_cents');
const ADMIT = body(bank.sql, 'fn_diamond_game_admit');
const DROP = body(host.sql, 'fn_plinko_drop');
const START = body(host.sql, 'fn_crash_start');
const DECIDE = body(host.sql, 'fn_crash_decide');
const TAKE = body(host.sql, 'fn_diamond_game_take_bet');
const PRIZE = body(bank.sql, 'fn_diamond_game_prize_leg');
const PAY = body(bank.sql, 'fn_diamond_game_pay_chips');
const AUDIT = body(games.sql, 'fn_plinko_table_audit');

/**
 * AMENDED 2026-09-21 - THE FIRST STEP NEVER RUINS A GAME, AND THE FLOOR IS
 * WHAT THE PLAYER PAID. Dan, verbatim, rulings R3, R6, R10 and R11:
 *   "The first step of a bonus game can never ruin it: the first tile selected
 *    in Mines must always be a diamond, never a bomb; the first street (Road
 *    crossing) must always be successful; the Crash ship can never explode
 *    until after 1.1x."
 *   "On Plinko the player must choose how many diamonds to drop and the value
 *    of each drop."
 *   "Minimum payout when they lose and get nothing goes from 0.10 to 0.50."
 *   "A 2,500 diamond spin plus a 2,500 diamond add-on must have a minimum
 *    payout of 50 chips for any game."
 *
 * supabase/migrations/20260921203512_the_first_step_of_a_bonus_game_never_ruins_it_and_the_floor_.sql
 * installs all four as contract 4 (payout_version 4) without repricing anything
 * sealed before it, and this law follows the arithmetic to where it leads:
 *
 *   - a certain step can pay only 0.80B, or must not be a cash-out point,
 *     because every stopping point is worth L + P(reach)(prize - L) = 0.80B.
 *     So the first mines gem and the first street pay exactly 0.80B, the mines
 *     ladder becomes L + (0.8B - L) C(24,k-1)/C(18,k-1) (the board is dealt
 *     AROUND the first pick, so P(survive k) = C(18,k-1)/C(24,k-1)), and the
 *     crash point is floored at 1.10x with cash-out from 1.11x, which leaves
 *     P(point >= x) = (0.8B - L)/(xB - L) untouched for every x above it;
 *   - a floor of half the stake, or two thirds of it when a Super player added
 *     the add-on, is still strictly below 0.80 of the stake for every reachable
 *     stake, so every game is still a 0.80 game; but it takes its mass from the
 *     top, so the Plinko table is chosen by the floor it can carry through its
 *     lowest slot (Super, 0.52x, for every half floor; Super Double, 0.72x, for
 *     the two thirds), Diamond (0.08x) closes, and the calibration pins move to
 *     what the flatter boards can honestly reach;
 *   - the drop count is the player's again, 1 to PLINKO_MAX_DROPS, so the
 *     reachability and distribution pins below are stated per drop count. A
 *     game of one drop is the same 0.80 with the whole board's variance; a game
 *     of a hundred is the same 0.80 with a tenth of it. The count that made the
 *     2026-09-19 defect (500 to 2,500 drops) is above the maximum and cannot
 *     come back.
 * Every number is still computed from the exported constants, exactly.
 */
const rules = latest('the_first_step_of_a_bonus_game_never_ruins_it_and_the_floor_');

/**
 * THE BOARD, DERIVED. A Plinko board is sixteen rows, so it has seventeen slots
 * and a ball lands in slot k with probability C(16,k)/65536. Nothing here is
 * typed out any more: the row count is read off the live mirror (slots minus
 * one), the weights come from the same `choose` the choice games use, and the
 * space is their sum - which must also be 2^rows, because every path down the
 * board is sixteen independent left/right bits. A hand-typed weight array
 * cannot be checked against anything; this one is checked against two
 * independent derivations at the top of the plinko block below.
 */
const BOARD_ROWS = PLINKO_TABLES[PLINKO_LIVE_TABLES[0]].multipliersCents.length - 1;
const SLOTS = BOARD_ROWS + 1;
const WEIGHTS = Array.from({ length: SLOTS }, (_, k) => choose(BOARD_ROWS, k));
const SPACE = WEIGHTS.reduce((a, b) => a + b, 0n);
/** The same numbers the audit spells out in SQL, for the number-typed reads below. */
const C16 = WEIGHTS.map(Number);
/** 0.80 - the house's four fifths - kept as a ratio so no assertion rounds it. */
const RETURN_NUM = 4n;
const RETURN_DEN = 5n;
/** 0.80 of the stake as a weight-sum over a whole board: 4/5 x 65,536 x 100 cents. */
const EXACT_RETURN_WEIGHT = (RETURN_NUM * SPACE * 100n) / RETURN_DEN;
/** "0.800000", the six-decimal figure the SQL audit gate compares against. */
const RTP = (Number(RETURN_NUM) / Number(RETURN_DEN)).toFixed(6);
/**
 * 20.00x. The top of every live board - both Plinko tables and the last street
 * of the one road - because 20x is inside every award's cover, so the top slot
 * is always actually payable rather than clipped to the cap. This is the one
 * design number in the file, pinned once and then required of three places.
 */
const TOP_CENTS = 2000;
/** One multiplier, in cents. `mult(5)` is the 5x Dan never saw. */
const mult = (x: number) => x * 100;
/** A stake of one chip, in cents: the unit every multiplier and floor is read against. */
const CHIP_CENTS = 100;
/**
 * The live ca_bridge_rate row is 100 diamonds to the chip (1 diamond = $0.01,
 * 1 chip = $1.00), so an entry of N diamonds is a stake of N chip cents. The
 * law above pins that the SQL READS that row and never writes the number; this
 * constant is only how the test spends an entry, and every assertion below is
 * stated in chip cents so it holds whatever the row says.
 */
const DIAMONDS_PER_CHIP = 100;

/** The table every half-floor stake plays (ordinary awards, Super without the
 * add-on) and the table a Super stake with the add-on plays. Nobody chooses. */
const SUPER = PLINKO_TABLES[4];
const SUPER_DOUBLE = PLINKO_TABLES[6];
/** The ordinary table of 2026-09-19, closed on 2026-09-21: kept readable for its receipts. */
const DIAMOND = PLINKO_TABLES[5];
/**
 * THE FOUR STAKE KINDS a wheel award can produce from one entry E: an ordinary
 * award (stake E, floor half), an ordinary award with the add-on (2E, half),
 * a Super award (2E, the entry E the player paid) and a Super award with the
 * add-on (3E, the 2E the player paid). Everything below is stated for all four.
 */
type StakeKind = {
  label: string;
  boost: 1 | 2;
  stakeOf: (e: number) => number;
  paidOf: (e: number) => number;
};
const STAKE_KINDS: StakeKind[] = [
  { label: 'ordinary', boost: 1, stakeOf: (e) => e, paidOf: (e) => e },
  { label: 'ordinary with add-on', boost: 1, stakeOf: (e) => 2 * e, paidOf: (e) => 2 * e },
  { label: 'Super', boost: 2, stakeOf: (e) => 2 * e, paidOf: (e) => e },
  { label: 'Super with add-on', boost: 2, stakeOf: (e) => 3 * e, paidOf: (e) => 2 * e },
];
/** The floor a kind carries on entry E, in chip cents, from the mirror. */
function floorCentsOf(kind: StakeKind, entry: number) {
  const stake = kind.stakeOf(entry);
  return Math.round(
    diamondBonusFloor(
      stake / DIAMONDS_PER_CHIP,
      kind.boost,
      kind.paidOf(entry),
      DIAMONDS_PER_CHIP
    ) * CHIP_CENTS
  );
}

/** A probability as a double, from an exact BigInt ratio. */
const ratio = (num: bigint, den: bigint) => Number(num) / Number(den);

/**
 * P(at least one of `drops` drops pays `floorCents` or better), EXACTLY where
 * the powers fit a double and as 1 - (1 - hit/space)^drops otherwise: P(none)
 * is ((space - hit)/space)^drops on the binomial weights, so nothing is
 * simulated and no seed can flatter the answer.
 */
function atLeastOneDrop(table: number[], floorCents: number, drops: number) {
  let hit = 0n;
  for (let k = 0; k < SLOTS; k++) if (table[k] >= floorCents) hit += WEIGHTS[k];
  const perDrop = ratio(hit, SPACE);
  const atLeastOne =
    drops <= 20
      ? ratio(SPACE ** BigInt(drops) - (SPACE - hit) ** BigInt(drops), SPACE ** BigInt(drops))
      : 1 - (1 - perDrop) ** drops;
  return { hit, perDrop, atLeastOne };
}

/**
 * THE EXACT DISTRIBUTION OF A WHOLE GAME of `drops` drops. Its return is
 * sum(multiplier cents)/(100 x drops) of the entry, and a total of 100 x drops
 * cents is exactly the entry back. Collapse the seventeen slots to their
 * distinct multipliers, then convolve that cents -> weight map `drops` times in
 * integer cents and BigInt weights: exact, no sampling, no floating point.
 *
 * It refuses BY NAME above EXACTLY_MEASURABLE_DROPS instead of grinding: a
 * test that dies on the runner's timeout reports "timed out", which names no
 * cause (CLAUDE.md 10.86 rule 1). Longer games are held to the variance
 * argument below instead, which is exact in integers at any count.
 */
const EXACTLY_MEASURABLE_DROPS = 20;
function gameDistribution(table: number[], drops: number): Map<number, bigint> {
  if (drops > EXACTLY_MEASURABLE_DROPS) {
    throw new Error(`A ${drops}-drop game cannot be measured exactly; use the variance bound.`);
  }
  const per = new Map<number, bigint>();
  for (let k = 0; k < SLOTS; k++) per.set(table[k], (per.get(table[k]) ?? 0n) + WEIGHTS[k]);
  let dist = new Map<number, bigint>([[0, 1n]]);
  for (let d = 0; d < drops; d++) {
    const next = new Map<number, bigint>();
    for (const [total, w] of dist)
      for (const [cents, weight] of per)
        next.set(total + cents, (next.get(total + cents) ?? 0n) + w * weight);
    dist = next;
  }
  return dist;
}

/** Weight of every game total at or above `cents`, and that as a probability. */
function atLeast(dist: Map<number, bigint>, all: bigint, cents: number) {
  let w = 0n;
  for (const [total, weight] of dist) if (total >= cents) w += weight;
  return { weight: w, p: ratio(w, all) };
}

/** The smallest game total x with P(total <= x) >= num/den. No interpolation, no sampling. */
function quantileCents(dist: Map<number, bigint>, all: bigint, num: number, den: number) {
  const totals = [...dist.keys()].sort((a, b) => a - b);
  let cum = 0n;
  for (const total of totals) {
    cum += dist.get(total) ?? 0n;
    if (cum * BigInt(den) >= all * BigInt(num)) return total;
  }
  return totals[totals.length - 1];
}

/** Var(one drop) in cents^2 as an exact ratio: (E[X^2] space - E[X]^2) / space^2. */
function dropVariance(table: number[]) {
  let m1 = 0n;
  let m2 = 0n;
  for (let k = 0; k < SLOTS; k++) {
    m1 += WEIGHTS[k] * BigInt(table[k]);
    m2 += WEIGHTS[k] * BigInt(table[k]) ** 2n;
  }
  return { num: m2 * SPACE - m1 * m1, den: SPACE * SPACE };
}
/**
 * sigma^2 from 0.80 to a doubling for an N-drop game, as an exact ratio: the
 * return has variance Var/(100^2 N) and the squared distance from 4/5 to 2 is
 * (6/5)^2, so sigma^2 = 36 x 10,000 x N x varDen / (25 x varNum).
 */
function sigmaSquaredToDoubling(table: number[], drops: number) {
  const v = dropVariance(table);
  return { num: 36n * 10000n * BigInt(drops) * v.den, den: 25n * v.num };
}

describe('the house share is arithmetic, not an odds table being honest', () => {
  it('a bet is whole chips at the bridge rate', () => {
    expect(ADMIT).toContain('o_rate := public.fn_ca_bridge_rate();');
    expect(ADMIT).toContain('p_bet % o_rate <> 0');
    expect(ADMIT).toContain('o_bet_chips := round(p_bet::numeric / o_rate, 2);');
    expect(ADMIT).not.toMatch(/o_rate\s*:=\s*\d/);
  });

  it('NOTHING IS MINTED, and the helper that minted is dropped', () => {
    expect(host.sql).toContain(
      'DROP FUNCTION IF EXISTS public.fn_diamond_game_mint_leg(uuid, text, numeric, text);'
    );
    for (const b of [DROP, START, ADMIT, CAP, PRIZE, TAKE]) {
      expect(b).not.toContain('issuance_reserve');
      expect(b).not.toContain('fn_diamond_game_mint_leg');
    }
    expect(host.sql).toContain('the host is the house: a game still mints');
  });

  it('the bet is paid through deduct_diamonds AND credited to the host owner', () => {
    expect(TAKE).toContain(
      "v_deduct := public.deduct_diamonds(p_user, p_bet, p_description, p_type, 'diamond_game',"
    );
    expect(TAKE).toContain(
      "v_credit := public.add_diamonds_to_balance(p_owner, p_bet, 'transfer', p_owner_note, p_reference || ':intake');"
    );
    expect(TAKE).toContain('the bet could not be credited to the host owner');
    // The owner is the union's owner for a union host, the club's for a club.
    const owner = body(host.sql, 'fn_diamond_game_owner');
    expect(owner).toContain('SELECT u.owner_id FROM public.unions u WHERE u.id = p_host');
    expect(owner).toContain('SELECT c.owner_id FROM public.clubs c WHERE c.id = p_host');
    expect(ADMIT).toContain('o_owner := public.fn_diamond_game_owner(o_host, o_kind);');
    expect(DROP).toContain("'plinko:' || v_id::text");
    expect(DROP).toContain("'plinko_drop'");
    expect(START).toContain("'crash:' || v_id::text");
    expect(START).toContain("'crash_bet'");
  });

  it('the money a payout comes out of is COVER: the promo wallet, then the bank', () => {
    expect(ADMIT).toContain('FROM public.fn_diamond_game_cover_lock(o_host, o_kind) c;');
    const lock = body(bank.sql, 'fn_diamond_game_cover_lock');
    expect(lock).toContain('SELECT COALESCE(w.promo_wallet, 0), COALESCE(w.chip_balance, 0)');
    expect(lock).toContain('SELECT COALESCE(c.promo_balance, 0), COALESCE(c.chip_treasury, 0)');
    expect(lock).toContain('FOR UPDATE');
    expect(lock).toContain('o_cover := o_promo + o_bank;');
  });
});

describe('the cap: a round is promised only what the pool can pay now', () => {
  it('is cap_fraction of the headroom, never above the ceiling, never above the bank', () => {
    // The headroom is what the game HAS TAKEN IN, this bet included.
    expect(CAP).toContain(
      'v_intake numeric := COALESCE(p_pool.intake_diamonds, 0) / public.fn_ca_bridge_rate() + p_bet_chips;'
    );
    expect(CAP).toContain('v_headroom  := v_intake + p_cfg.exposure_allowance_chips');
    expect(CAP).toContain('- COALESCE(p_pool.chips_paid, 0) - COALESCE(p_pool.reserved_chips, 0);');
    expect(CAP).toContain(
      'v_bank_room := COALESCE(p_bank, 0) - COALESCE(p_pool.reserved_chips, 0);'
    );
    expect(CAP).toContain('floor(p_cfg.cap_fraction * v_headroom / p_bet_chips * 100)');
    expect(CAP).toContain('floor(v_bank_room / p_bet_chips * 100)');
    expect(games.sql).toMatch(
      /cap_fraction\s+numeric\(4,3\) NOT NULL DEFAULT 0\.950 CHECK \(cap_fraction > 0 AND cap_fraction < 1\)/
    );
  });

  it('plinko plays min(table, cap) and refuses a bet the cap cannot lift above 1.01x', () => {
    expect(DROP).toContain('v_mult := LEAST(v_table_mult, v_cap);');
    expect(DROP).toContain('IF v_cap < 101 THEN');
    expect(DROP).toContain('v_payout := round(adm.o_bet_chips * v_mult / 100, 2);');
  });

  it('crash reserves bet x cap while the round is open and pays never more than that', () => {
    expect(START).toContain('v_reserve := round(adm.o_bet_chips * v_cap / 100, 2);');
    expect(START).toContain('reserved_chips = reserved_chips + v_reserve,');
    expect(DECIDE).toContain('IF v_payout > r.reserved_chips THEN');
    expect(DECIDE).toContain('reserved_chips = reserved_chips - r.reserved_chips,');
    expect(games.sql).toMatch(
      /reserved_chips\s+numeric\(16,2\) NOT NULL DEFAULT 0 CHECK \(reserved_chips >= 0\)/
    );
  });

  it('re-checks the invariant after every move and raises if the cap was bypassed', () => {
    expect(DROP).toContain(
      'IF pool.chips_paid + pool.reserved_chips > v_intake_chips + (adm.o_cfg).exposure_allowance_chips THEN'
    );
    expect(START).toContain(
      'IF pool.chips_paid + pool.reserved_chips > v_intake_chips + (adm.o_cfg).exposure_allowance_chips THEN'
    );
    expect(DECIDE).toContain(
      'IF pool.chips_paid + pool.reserved_chips > v_intake_chips + cfg.exposure_allowance_chips + 0.000001 THEN'
    );
    // And v_intake_chips is read off the pool, never off a mint that no longer happens.
    for (const b of [DROP, START, DECIDE]) {
      expect(b).toMatch(/v_intake_chips := round\(pool\.intake_diamonds::numeric \/ /);
    }
    for (const b of [DROP, START, DECIDE]) expect(b).toContain('the cap was bypassed');
  });
});

describe('plinko returns exactly 80 percent or the table cannot be activated', () => {
  it('the board is sixteen rows and its weights agree with two independent derivations', () => {
    // Protects the arithmetic every other assertion in this block stands on.
    // The weights are C(16,k) from the choice games' own `choose`; they must
    // also sum to 2^16, because a path down the board is sixteen independent
    // left/right bits, and the SQL audit spells the same seventeen numbers out.
    expect(BOARD_ROWS).toBe(16);
    expect(SLOTS).toBe(17);
    expect(SPACE).toBe(1n << BigInt(BOARD_ROWS));
    expect(SPACE).toBe(65536n);
    for (const version of PLINKO_LIVE_TABLES)
      expect(PLINKO_TABLES[version].multipliersCents.length).toBe(SLOTS);
    expect(EXACT_RETURN_WEIGHT).toBe(5242880n);
  });

  it('the audit derives the return from the binomial weights of a 16-row board', () => {
    expect(AUDIT).toContain(`ARRAY[${C16.join(',')}]`);
    expect(AUDIT).toContain(`spec_rtp := round(v_ev / (${SPACE} * 100), 6);`);
    const act = body(games.sql, 'fn_plinko_activate_table');
    expect(act).toContain(`IF a.spec_rtp <> ${RTP} THEN`);
    const cfg = body(games.sql, 'fn_diamond_game_set_config');
    expect(cfg).toContain(`WHERE t.activated_at IS NOT NULL AND a.spec_rtp = ${RTP}`);
  });

  /**
   * 2026-09-19: THIS NOW PINS THE THREE CLOSED LAUNCH TABLES, AND THE PINS ARE
   * KEPT DELIBERATELY. Steady, Bold and Moonshot were deactivated by the
   * recalibration migration (their settled batches keep their receipts), so
   * this is a read of history - but it is the proof that the ACTIVATION GATE
   * has always been exact arithmetic rather than a table author's good faith,
   * and the dead centre it asserts is exactly the shape the live tables are now
   * forbidden to have. Steady and Bold paid nothing on the single centre slot,
   * Moonshot on three of them, and 80.4 percent hit rate on a 500-drop game is
   * how "never cleared 21 chips" happened. The live tables are measured in the
   * next assertion; every slot on both of them pays.
   */
  it('every closed launch table still sums to exactly 0.80 of the board, with the dead centre it was retired for', () => {
    const block = games.sql.slice(
      games.sql.indexOf('INSERT INTO public.plinko_tables'),
      games.sql.indexOf('ON CONFLICT (version) DO NOTHING')
    );
    const rows = [...block.matchAll(/\((\d+), '([^']+)',\s*ARRAY\[([\d,]+)\], (\d+),/g)];
    expect(rows.length).toBe(3);
    for (const [, , name, list, max] of rows) {
      const m = list.split(',').map(Number);
      expect(m.length, name).toBe(SLOTS);
      expect(m[BOARD_ROWS / 2], `${name} centre`).toBe(0);
      let total = 0;
      for (let k = 0; k < SLOTS; k++) {
        total += C16[k] * m[k];
        expect(m[k], `${name} symmetric`).toBe(m[BOARD_ROWS - k]);
      }
      expect(total, name).toBe(Number(EXACT_RETURN_WEIGHT));
      expect(Math.max(...m)).toBe(Number(max));
    }
    // Moonshot: 1000x at the edge, the table Dan asked for when he said "50x can be higher".
    expect(block).toContain("(3, 'Moonshot', ARRAY[100000,");
    // And the recalibration closed all three, so a game can only ever be dealt
    // one of the two tables measured below.
    expect(calib.sql).toContain(
      'UPDATE public.plinko_tables SET activated_at=NULL WHERE version IN (1,2,3);'
    );
    expect(calib.sql).toContain(
      'IF (SELECT count(*) FROM public.plinko_tables WHERE activated_at IS NOT NULL)<>2'
    );
    // 2026-09-21: Diamond (5) closes too, and for the opposite reason - not a
    // dead centre but a centre too LOW to carry the half-stake floor. The
    // migration closes it and asserts exactly Super and Super Double are open.
    expect(rules.sql).toContain(
      'UPDATE public.plinko_tables SET activated_at=NULL WHERE version=5;'
    );
    expect(rules.sql).toContain(
      'IF (SELECT array_agg(version ORDER BY version) FROM public.plinko_tables WHERE activated_at IS NOT NULL) IS DISTINCT FROM ARRAY[4,6] THEN'
    );
    expect(Math.min(...DIAMOND.multipliersCents) * 2, 'Diamond could carry the half').toBeLessThan(
      CHIP_CENTS
    );
  });

  /**
   * ITEM 1 OF THE CALIBRATION CONTRACT (2026-09-19, re-stated 2026-09-21 for
   * the two tables now open). Both LIVE tables, measured off the exported
   * mirror in integer arithmetic:
   *
   *   - sum over k of C(16,k) x multiplier_cents[k] === 0.80 x 65,536 x 100,
   *     exactly. Measured: 5,242,880 on both, with no remainder to round away;
   *   - both top out at exactly 20.00x - 20x is inside every award's cover, so
   *     the top slot is a prize that actually gets paid rather than one clipped
   *     to min(table, cap) on the way out;
   *   - NO SLOT PAYS NOTHING, and every slot pays at least the floor its table
   *     exists to carry (item 2).
   */
  it('both live tables return exactly 0.80, top out at exactly 20x, and have no dead slot', () => {
    expect([...PLINKO_LIVE_TABLES]).toEqual([4, 6]);
    for (const version of PLINKO_LIVE_TABLES) {
      const table = PLINKO_TABLES[version];
      expect(table, `live table ${version} does not exist in the mirror`).toBeTruthy();
      const m = table.multipliersCents;
      expect(m.length, `${table.name} slots`).toBe(SLOTS);
      let weighted = 0n;
      for (let k = 0; k < SLOTS; k++) {
        weighted += WEIGHTS[k] * BigInt(m[k]);
        expect(m[k], `${table.name} slot ${k} pays nothing`).toBeGreaterThan(0);
        expect(m[k], `${table.name} is not symmetric at slot ${k}`).toBe(m[BOARD_ROWS - k]);
      }
      // Exact, in integers: 5,242,880 === 4/5 x 65,536 x 100. No rounding.
      expect(weighted, `${table.name} does not return exactly ${RTP}`).toBe(EXACT_RETURN_WEIGHT);
      expect(weighted * RETURN_DEN).toBe(RETURN_NUM * SPACE * 100n);
      expect(Math.max(...m), `${table.name} top`).toBe(TOP_CENTS);
    }
  });

  /**
   * ITEM 2. THE TABLE FOLLOWS THE FLOOR (2026-09-21). Dan, 2026-09-19: "They
   * must all pay a minimum of 1:1 value even if they lose and don't cash out";
   * 2026-09-21: the ordinary floor is half the stake (R10) and a Super floor is
   * what the player paid, add-on included (R11).
   *
   * A floor top-up above the table's lowest slot ADDS expectation, so a floor
   * has to be carried by the board itself: the Super table's lowest slot is
   * 0.52x, above the half, and the Super Double table's is 0.72x, above the two
   * thirds a Super player with the add-on paid. Every run therefore returns at
   * least its floor through the multipliers, and the floor is never what pays
   * (up to cent rounding). plinkoTableForFloor picks the lowest-slot open table
   * that carries the floor, so the two-thirds floor lands on Super Double and
   * every half floor on Super. Diamond's 0.08x could carry neither, which is
   * why it closed.
   */
  it('each live table carries its floor through its multipliers, and the floor picks the table', () => {
    const halfCents = CHIP_CENTS / 2;
    const twoThirdsNum = 2;
    const twoThirdsDen = 3;
    const lowestSuper = Math.min(...SUPER.multipliersCents);
    const lowestDouble = Math.min(...SUPER_DOUBLE.multipliersCents);
    // Measured: 52 against a 50-cent half; 72 against 66.67 cents of two thirds.
    expect(lowestSuper).toBeGreaterThanOrEqual(halfCents);
    expect(lowestDouble * twoThirdsDen).toBeGreaterThanOrEqual(CHIP_CENTS * twoThirdsNum);
    expect(lowestSuper * twoThirdsDen, 'Super could carry two thirds').toBeLessThan(
      CHIP_CENTS * twoThirdsNum
    );
    // The routing, on every reachable stake of every kind.
    for (let entry = MIN_DIAMOND_SPIN; entry <= MAX_DIAMOND_SPIN; entry++) {
      for (const kind of STAKE_KINDS) {
        const stake = kind.stakeOf(entry);
        const floorCents = floorCentsOf(kind, entry);
        const version = plinkoTableForFloor(stake / DIAMONDS_PER_CHIP, floorCents / CHIP_CENTS);
        expect(version, `${kind.label} ${entry}`).toBe(kind.label === 'Super with add-on' ? 6 : 4);
        // And the chosen table's lowest slot really covers the floor on that stake, in cents.
        const lowest = Math.min(...PLINKO_TABLES[version as number].multipliersCents);
        expect(lowest * stake).toBeGreaterThanOrEqual(CHIP_CENTS * floorCents);
      }
    }
    // A floor no open table can carry is refused, not topped up.
    expect(plinkoTableForFloor(1, 0.8)).toBeNull();
  });

  it('the ball follows sixteen bits of the HMAC and the slot is the number of rights', () => {
    expect(DROP).toContain(`FOR i IN 0..${BOARD_ROWS - 1} LOOP`);
    expect(DROP).toContain('IF get_bit(v_hmac, i) = 1 THEN');
    expect(DROP).toContain('v_slot := v_slot + 1;');
    expect(DROP).toContain('v_table_mult := t.multipliers_cents[v_slot + 1];');
  });
});

describe('crash returns exactly 80 percent at every cash-out target', () => {
  it('the crash point is floor(80 * 2^48 / (r + 1)) cents, floored at 1.00', () => {
    const p = body(games.sql, 'fn_crash_point_cents');
    expect(p).toContain(
      'GREATEST(100::bigint, floor(22517998136852480::numeric / (p_roll + 1))::bigint)'
    );
    expect(22517998136852480n).toBe(80n * 2n ** 48n);
    // The migration asserts the pinned vector before it commits.
    expect(games.sql).toContain(
      "IF v_x <> 201 THEN RAISE EXCEPTION 'POST-APPLY: crash point for the pinned roll is %, expected 201', v_x; END IF;"
    );
  });

  it('the server clock decides a round; the browser only asks', () => {
    expect(DECIDE).toContain(
      'v_elapsed_ms := floor(extract(epoch FROM (clock_timestamp() - r.started_at)) * 1000)::bigint;'
    );
    expect(DECIDE).toContain(
      'v_now_cents := public.fn_crash_multiplier_cents(r.growth_k, v_elapsed_ms, r.cap_cents);'
    );
    // an auto target below the crash point is honoured the moment the curve passes it
    expect(DECIDE).toContain(
      'IF r.auto_cashout_cents IS NOT NULL AND r.auto_cashout_cents < r.crash_cents AND v_now_cents >= r.auto_cashout_cents THEN'
    );
    // reaching the cap before the crash point cashes at the cap
    expect(DECIDE).toContain(
      'ELSIF r.crash_cents >= r.cap_cents AND v_now_cents >= r.cap_cents THEN'
    );
    // reaching the crash point pays nothing
    expect(DECIDE).toContain('ELSIF v_now_cents >= r.crash_cents THEN');
    expect(DECIDE).toContain("v_result := 'crashed'; v_at_cents := NULL;");
    // a manual cash-out is the server's reading, never a number the client sent
    const settle = body(games.sql, 'fn_crash_settle');
    expect(settle).not.toMatch(/p_cents|p_multiplier/);
    expect(games.sql).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_crash_settle(p_round_id uuid, p_cashout boolean)'
    );
  });

  it('an open round reveals nothing that gives the crash point away', () => {
    const r = body(games.sql, 'fn_crash_round_result');
    expect(r).toContain("|| CASE WHEN r.status = 'open' THEN '{}'::jsonb");
    expect(r).toContain(
      "ELSE jsonb_build_object('server_seed', r.server_seed, 'roll', r.roll, 'crash_cents', r.crash_cents) END"
    );
    expect(r).toContain(
      "'outcome', CASE WHEN r.status = 'open' THEN NULL ELSE jsonb_build_object("
    );
  });

  it('time settles a decided round on the live path, not by a cron', () => {
    const decided = body(games.sql, 'fn_crash_settle_decided');
    expect(decided).toContain("WHERE c.host_id = p_host AND c.status = 'open'");
    expect(decided).toContain('ln(c.cap_cents::numeric / 100) / c.growth_k');
    expect(ADMIT).toContain('PERFORM public.fn_crash_settle_decided(o_host);');
    expect(games.sql).not.toMatch(/cron\.schedule/);
    expect(games.sql).not.toMatch(/fn_\w*(repair|backpay|redrive|sweep|catchup|heal)\w*/);
  });
});

describe("every payout is the platform's own door, and nobody is filtered", () => {
  it('a payout leaves through the one payer: promo wallet first, bank behind', () => {
    // The prize leg keeps its signature so plinko and crash call it unchanged;
    // what moved is where the chips come from.
    expect(PRIZE).toContain('SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips(');
    expect(PRIZE).toContain(
      "p_game || '_prize', p_host, p_kind, p_club, p_user, p_amount, p_key, p_note, p_meta);"
    );
    expect(PRIZE).toContain('bank_after   := v_pay.cover_after;');
    // It moves no wallet of its own any more.
    expect(PRIZE).not.toContain('UPDATE public.union_wallets');
    expect(PRIZE).not.toContain('UPDATE public.clubs');
    expect(PRIZE).not.toContain('chip_treasury');

    // And the payer draws the promo wallet down first, then the bank, one
    // journal row per wallet, each from the side that actually paid.
    expect(PAY).toContain('from_promo := LEAST(p_amount, v_lock.o_promo);');
    expect(PAY).toContain('from_bank  := p_amount - from_promo;');
    expect(PAY).toContain(
      'UPDATE public.union_wallets SET promo_wallet = COALESCE(promo_wallet, 0) - from_promo'
    );
    expect(PAY).toContain(
      'UPDATE public.clubs SET promo_balance = COALESCE(promo_balance, 0) - from_promo'
    );
    expect(PAY).toContain(
      'UPDATE public.union_wallets SET chip_balance = COALESCE(chip_balance, 0) - from_bank'
    );
    expect(PAY).toContain(
      'UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) - from_bank'
    );
    expect(PAY).toContain("p_key || ':bank'");
    expect(PAY).toContain('the promo wallet moved but no leg was journaled');
    expect(PAY).toContain('the host bank moved but no leg was journaled');
    expect(PAY).toContain("PERFORM set_config('app.ledger_autoskip_club_members', '', true);");
    expect(words.sql).toContain("'plinko_prize'::text, 'crash_prize'::text");
    expect(words.sql).toMatch(/NOT VALID;/);
  });

  it('the round is measured against COVER, and the two halves are reported', () => {
    // The signature lives above the body, so it is read off the migration.
    expect(bank.sql).toContain('OUT o_bank numeric, OUT o_promo numeric, OUT o_bank_only numeric');
    expect(ADMIT).toContain('SELECT c.o_promo, c.o_bank, c.o_cover');
    expect(ADMIT).toContain('INTO o_promo, o_bank_only, o_bank');
    expect(ADMIT).toContain('FROM public.fn_diamond_game_cover_lock(o_host, o_kind) c;');
    // The promo wallet alone is never what a bet is judged against any more.
    expect(ADMIT).not.toContain('fn_diamond_game_promo_lock');
  });

  it('nothing in these games moves a host wallet except the payer', () => {
    expect(bank.sql).toContain(
      'a diamond game still moves a host wallet itself instead of calling fn_diamond_game_pay_chips'
    );
    expect(bank.sql).toContain(
      "'fn_wheel_spin_core', 'fn_plinko_drop', 'fn_crash_start', 'fn_crash_decide'"
    );
  });

  it('never mentions is_horse: horses are players (CLAUDE.md 10.5)', () => {
    expect(games.sql).not.toMatch(/is_horse/);
    expect(opens.sql).not.toMatch(/is_horse/);
  });

  it('the wheel opened with a seeded diamond float, and it still bounds the diamond side', () => {
    expect(opens.sql).toMatch(
      /ADD COLUMN IF NOT EXISTS diamond_seed integer NOT NULL DEFAULT 2500 CHECK \(diamond_seed >= 0\)/
    );
    const t = body(opens.sql, 'fn_wheel_pool_seed');
    expect(t).toContain(
      'NEW.diamond_float := COALESCE(NEW.diamond_float, 0) + COALESCE(v_seed, 0);'
    );
    // 2026-09-10: the house take is what the host kept - everything it took in,
    // less the chips and the diamonds it paid back out. Nothing is minted, so
    // there is no mint to subtract and no seed to net out.
    const m = body(host.sql, 'fn_wheel_metrics');
    expect(m).toContain('THEN round(pool.intake_diamonds::numeric / v_rate - pool.chips_paid');
    expect(m).toContain('- pool.diamonds_paid::numeric / v_rate, 4) END,');
    expect(m).not.toContain('pool.chips_minted');
  });

  it('the registry knows the three money movers', () => {
    expect(games.sql).toContain("('fn_plinko_drop', 'approved',");
    expect(games.sql).toContain("('fn_crash_start', 'approved',");
    expect(games.sql).toContain("('fn_crash_settle', 'approved',");
  });
});

/**
 * THE CALIBRATION: A TABLE THAT KEEPS THE EDGE AND STILL CANNOT PAY IS BROKEN
 * ═══════════════════════════════════════════════════════════════════════════
 * Everything above proves the house never pays out more than it takes in.
 * Nothing above proves the player can ever win, and for a year that was the
 * whole of the contract - which is how twenty 2,500-diamond awards returned
 * about twenty chips each while every assertion in this file stayed green.
 *
 * These are the assertions that were missing. Every one is computed from the
 * exported constants and from the binomial weights, exactly: no simulation, no
 * seed, no sampling, no floating-point tolerance on anything that decides a
 * verdict. The measured value sits in the comment beside each bound, so a
 * future table that is FLATTER than today's fails here rather than shipping.
 *
 * RE-STATED 2026-09-21 (owner rulings R6, R10, R11). The floor of half the
 * stake, and two thirds with the add-on, takes its prize mass from the top by
 * arithmetic, and the drop count is the player's from 1 to PLINKO_MAX_DROPS.
 * So the pins are stated per live table and per drop count, at the values the
 * flatter boards honestly reach: the player now chooses the variance, and the
 * law's job is that a one-drop game is a real shot at the top and a hundred-
 * drop game is still the same 0.80 rather than a game that cannot pay.
 */
describe('the calibration: the live tables can actually be hit, and a game can actually pay', () => {
  /**
   * ITEM 3. REACHABILITY, MEASURED EXACTLY. Dan's sentence was "never saw a 5x,
   * 10x or 20x", so those are the three thresholds, at one drop, ten and the
   * maximum. P(at least one) is 1 - ((65,536 - hit)/65,536)^drops.
   *
   * Measured per drop (weight of 65,536):
   *     Super         5x+ 1,394 (1 in 47)   10x+ 274 (1 in 239)   20x 34 (1 in 1,928)
   *     Super Double  5x+   274 (1 in 239)  10x+ 274 (1 in 239)   20x 34 (1 in 1,928)
   * and per game:
   *     Super         10 drops: 19.35% / 4.10% / 0.52%   100 drops: 88.4% / 34.2% / 5.06%
   *     Super Double  10 drops:  4.10% / 4.10% / 0.52%   100 drops: 34.2% / 34.2% / 5.06%
   *
   * The weights are pinned as exact lower bounds, so a slot quietly demoted
   * out of a band is caught even where a rounded probability stays above its
   * bound, and each threshold is at most as easy as the last.
   */
  it('a live game reaches 5x, 10x and 20x, and more often the more drops it plays', () => {
    const expectations: Record<number, { five: bigint; ten: bigint; top: bigint }> = {
      4: { five: 1394n, ten: 274n, top: 34n },
      6: { five: 274n, ten: 274n, top: 34n },
    };
    for (const version of PLINKO_LIVE_TABLES) {
      const table = PLINKO_TABLES[version].multipliersCents;
      const want = expectations[version];
      let previousTop = 0;
      for (const drops of [PLINKO_MIN_DROPS, 10, PLINKO_MAX_DROPS]) {
        const five = atLeastOneDrop(table, mult(5), drops);
        const ten = atLeastOneDrop(table, mult(10), drops);
        const top = atLeastOneDrop(table, TOP_CENTS, drops);
        expect(five.hit, `table ${version} 5x band lost weight`).toBeGreaterThanOrEqual(want.five);
        expect(ten.hit, `table ${version} 10x band lost weight`).toBeGreaterThanOrEqual(want.ten);
        expect(top.hit, `table ${version} top band lost weight`).toBeGreaterThanOrEqual(want.top);
        expect(top.hit).toBeLessThanOrEqual(ten.hit);
        expect(ten.hit).toBeLessThanOrEqual(five.hit);
        // More drops, more chances: strictly, so a count can never make the top rarer.
        expect(top.atLeastOne).toBeGreaterThan(previousTop);
        previousTop = top.atLeastOne;
      }
      // At the maximum a game shows the 20x top one time in twenty (measured 5.06%),
      // the 5x band better than one game in three (34.2% on Super Double).
      expect(atLeastOneDrop(table, TOP_CENTS, PLINKO_MAX_DROPS).atLeastOne).toBeGreaterThan(0.05);
      expect(atLeastOneDrop(table, mult(5), PLINKO_MAX_DROPS).atLeastOne).toBeGreaterThan(1 / 3);
      // The top is on the two outer slots each side, never rarer than 1 in 2,000 a drop.
      expect(atLeastOneDrop(table, TOP_CENTS, 1).perDrop).toBeGreaterThan(1 / 2000);
    }
  });

  /**
   * ITEM 4. THE EXACT DISTRIBUTION OF A TEN-DROP GAME on each live table: the
   * seventeen-slot distribution convolved ten times in integer cents and BigInt
   * weights, 65,536^10 total weight. A total of 1,000 multiplier cents is
   * exactly the entry back.
   *
   * Measured (exact, not sampled):
   *     Super         mean 0.800000  P(>= entry) 19.48%  P(>= 2x) 3.45%  p50 0.661x  p99 2.497x  9,004 outcomes
   *     Super Double  mean 0.800000  P(>= entry)  4.16%  P(>= 2x) 0.58%  p50 0.741x  p99 1.757x  3,971 outcomes
   *
   * The half floor and the two-thirds floor are why these are lower than the
   * closed Diamond table's 27.98% / 6.79%: the guaranteed loss is paid for out
   * of the wins. The bounds are 15% / 2% on Super and 3% / 0.4% on Super
   * Double, and the mean is pinned EXACTLY in integers, because a recalibration
   * that bought pay frequency by shaving the edge is the faucet this law keeps
   * shut.
   */
  it('an exact ten-drop game on each live table returns its entry often enough, and averages exactly 0.80', () => {
    const drops = 10;
    expect(drops).toBeLessThanOrEqual(EXACTLY_MEASURABLE_DROPS);
    const bounds: Record<number, { back: number; twice: number }> = {
      4: { back: 0.15, twice: 0.02 },
      6: { back: 0.03, twice: 0.004 },
    };
    for (const version of PLINKO_LIVE_TABLES) {
      const table = PLINKO_TABLES[version].multipliersCents;
      const dist = gameDistribution(table, drops);
      const all = SPACE ** BigInt(drops);
      const entryCents = CHIP_CENTS * drops;
      let weight = 0n;
      for (const w of dist.values()) weight += w;
      expect(weight).toBe(all);
      expect(dist.size).toBeGreaterThan(1);
      expect(atLeast(dist, all, entryCents).p, `table ${version} entry`).toBeGreaterThan(
        bounds[version].back
      );
      expect(atLeast(dist, all, 2 * entryCents).p, `table ${version} 2x`).toBeGreaterThan(
        bounds[version].twice
      );
      // THE EDGE, EXACTLY, ON THE WHOLE GAME: mean x 5 === 4 x entry x total weight.
      let mean = 0n;
      for (const [total, w] of dist) mean += BigInt(total) * w;
      expect(mean * RETURN_DEN, `table ${version} mean`).toBe(
        RETURN_NUM * BigInt(entryCents) * all
      );
      expect(mean).toBe(BigInt(drops) * EXACT_RETURN_WEIGHT * SPACE ** BigInt(drops - 1));
      // The extremes are the table's own, ten times over: nothing is clipped, and
      // the worst game is above the floor its table carries (item 2), never below.
      const totals = [...dist.keys()].sort((a, b) => a - b);
      expect(totals[0]).toBe(drops * Math.min(...table));
      expect(totals[totals.length - 1]).toBe(drops * TOP_CENTS);
      expect(totals[0] * 2).toBeGreaterThanOrEqual(entryCents);
      // The best game in a hundred beats the entry on both boards (measured 2.497x
      // and 1.757x), and doubles it on the half-floor board. The median is a loss:
      // this is a 0.80 game, not a giveaway.
      const p99 = quantileCents(dist, all, 99, 100);
      expect(p99, `table ${version} p99`).toBeGreaterThan(entryCents);
      if (version === 4) expect(p99).toBeGreaterThanOrEqual(2 * entryCents);
      expect(quantileCents(dist, all, 50, 100)).toBeLessThan(entryCents);
    }
  });

  /**
   * ITEM 5. THE DROP COUNT IS THE PLAYER'S, WITHIN BOUNDS THAT KEEP IT A GAME
   * (Dan, 2026-09-21, R6: "the player must choose how many diamonds to drop and
   * the value of each drop"). The server admits a listed drop value that uses
   * every diamond in PLINKO_MIN_DROPS..PLINKO_MAX_DROPS drops, and the whole
   * stake as one drop, always.
   *
   * The count is a variance dial and nothing else: the mean is 0.80 at every
   * count. In sigmas from 0.80 to a doubling (exact integers, off each table's
   * own variance):
   *     Super         1 drop 0.89   10 drops 2.82   100 drops 8.93   500 drops 19.97   2,500 drops 44.66
   *     Super Double  1 drop 1.67   10 drops 5.27   100 drops 16.66  500 drops 37.25   2,500 drops 83.29
   * So a one-drop game is a real shot at a doubling on both boards (under two
   * sigma), and the 500-to-2,500-drop game Dan actually played on 2026-09-19 is
   * above PLINKO_MAX_DROPS and cannot be started. The bounds move with the
   * tables; the maximum is pinned so the old calibration cannot return by a
   * denomination of one on a 2,500-diamond award.
   */
  it('every stake has a legal drop count, none exceeds a hundred, and one drop is a real shot', () => {
    expect(PLINKO_MIN_DROPS).toBe(1);
    expect(PLINKO_MAX_DROPS).toBe(100);
    expect([...PLINKO_DENOMINATIONS]).toEqual([1, 2, 4, 5, 10, 20, 25, 50, 100, 250, 500]);
    for (let entry = MIN_DIAMOND_SPIN; entry <= MAX_DIAMOND_SPIN; entry++) {
      for (const kind of STAKE_KINDS) {
        const stake = kind.stakeOf(entry);
        const choices = plinkoDropChoices(stake);
        expect(choices.length, `${kind.label} ${entry} has no drop value`).toBeGreaterThan(0);
        for (const c of choices) {
          expect(c.denomination * c.drops).toBe(stake);
          expect(c.drops).toBeGreaterThanOrEqual(PLINKO_MIN_DROPS);
          expect(c.drops).toBeLessThanOrEqual(PLINKO_MAX_DROPS);
          expect(PLINKO_DENOMINATIONS.includes(c.denomination) || c.denomination === stake).toBe(
            true
          );
        }
        // The whole stake as one drop is always on the menu.
        expect(choices.some((c) => c.drops === 1 && c.denomination === stake)).toBe(true);
      }
    }
    // The 2026-09-19 game: 500 and 2,500 drops on a 2,500-diamond award. Gone.
    expect(plinkoDropChoices(MAX_DIAMOND_SPIN).some((c) => c.drops === 500)).toBe(false);
    expect(plinkoDropChoices(MAX_DIAMOND_SPIN).some((c) => c.drops === 2500)).toBe(false);
    expect(plinkoDropChoices(MAX_DIAMOND_SPIN).some((c) => c.drops === PLINKO_MAX_DROPS)).toBe(
      true
    );

    for (const version of PLINKO_LIVE_TABLES) {
      const table = PLINKO_TABLES[version].multipliersCents;
      // One drop: under two sigma to a doubling on both boards (0.89 and 1.67).
      const one = sigmaSquaredToDoubling(table, PLINKO_MIN_DROPS);
      expect(one.num).toBeLessThan(4n * one.den);
      // The maximum: still the same exact 0.80 mean, less variance; and every
      // count above it is where the top stops being a prize (19.97 sigma at 500).
      const max = sigmaSquaredToDoubling(table, PLINKO_MAX_DROPS);
      const old = sigmaSquaredToDoubling(table, MAX_DIAMOND_SPIN / 5);
      expect(old.num * max.den).toBeGreaterThan(max.num * old.den);
      expect(old.num).toBeGreaterThan(100n * old.den);
    }
  });
});

/**
 * ITEM 6. THE GUARANTEE (Dan 2026-09-19 "at least 1:1"; 2026-09-21 R10 "0.10 to
 * 0.50" and R11 "2,500 + 2,500 must have a minimum payout of 50 chips").
 *
 * An ordinary award keeps HALF its stake on a loss. A Super award keeps the
 * greater of half its stake and what the player PAID: the spin entry, plus the
 * Double Diamonds add-on when it was bought. So without the add-on the Super
 * floor is the entry (unchanged from 2026-09-19), and with it two thirds of the
 * stake. The three things that can go wrong are all pinned: a floor that is not
 * whole cents cannot be paid; a Super floor below what was paid breaks the
 * promise; and a floor at or above 0.80 of the stake is a game with a NEGATIVE
 * edge, which both choice games refuse outright (minePrizeV4 and roadSurvives
 * throw when 5L >= 4B) and which would make this file's never-pay-more promise
 * false. The migration clamps a cent under 0.80B; the walk below proves the
 * clamp never binds on any reachable stake, so no floor is ever silently cut.
 */
describe('the guarantee: a Super game pays what the player paid, and no floor beats the edge', () => {
  it('every entry from 25 to 2,500 diamonds keeps whole cents on all four stake kinds', () => {
    for (let entry = MIN_DIAMOND_SPIN; entry <= MAX_DIAMOND_SPIN; entry++) {
      for (const kind of STAKE_KINDS) {
        const stakeCents = kind.stakeOf(entry);
        const floor = diamondBonusFloor(
          stakeCents / DIAMONDS_PER_CHIP,
          kind.boost,
          kind.paidOf(entry),
          DIAMONDS_PER_CHIP
        );
        const floorCents = Math.round(floor * CHIP_CENTS);
        expect(Number.isSafeInteger(floorCents)).toBe(true);
        expect(Math.abs(floorCents - floor * CHIP_CENTS)).toBeLessThan(1e-9);
        // The designed value: half the stake rounded up, or the paid diamonds.
        const half = Math.ceil(stakeCents / 2);
        const paid = kind.paidOf(entry);
        const designed = kind.boost === 2 ? Math.max(half, paid) : half;
        expect(floorCents, `${kind.label} ${entry}`).toBe(designed);
        // A Super award never returns less than the spin, and with the add-on
        // never less than the spin plus the add-on: 1:1 on the money paid.
        if (kind.boost === 2) expect(floorCents).toBeGreaterThanOrEqual(paid);
        // Never at or above 0.80 of the stake, and the clamp did not fire.
        expect(floorCents * 5, `${kind.label} ${entry} floor beats the edge`).toBeLessThan(
          4 * stakeCents
        );
        expect(floorCents).toBeLessThan(Math.ceil(stakeCents * 0.8));
      }
    }
    // The owner's example, to the cent: 50 chips on 2,500 + 2,500; 25 without the add-on.
    expect(diamondBonusFloor(75, 2, 5000, 100)).toBe(50);
    expect(diamondBonusFloor(50, 2, 2500, 100)).toBe(25);
    expect(diamondBonusFloor(25, 1, 2500, 100)).toBe(12.5);
    // And the old rule is still the old rule, for receipts sealed under it.
    expect(diamondBonusMinimum(25, 1)).toBe(2.5);
    expect(diamondBonusMinimum(50, 2)).toBe(25);
  });

  it('contract 4 is a fourth payout version, and every older receipt keeps its own', () => {
    expect(BONUS_PAYOUT_VERSION).toBe(4);
    // The migration reads the owner's example back from the rule it installed,
    // checked against the client mirror rather than re-typed.
    expect(rules.sql).toContain(
      `IF public.fn_diamond_bonus_floor(75,2,5000,100)<>${diamondBonusFloor(75, 2, 5000, 100)}` +
        ` OR public.fn_diamond_bonus_floor(50,2,2500,100)<>${diamondBonusFloor(50, 2, 2500, 100)}`
    );
    expect(rules.sql).toContain(
      'SELECT LEAST(\n  CASE WHEN p_boost=2 THEN GREATEST(ceil(p_bet*50)/100, ceil(p_paid_diamonds::numeric*100/p_rate)/100) ELSE ceil(p_bet*50)/100 END,\n  (ceil(p_bet*80)-1)/100)'
    );
    // The version is a column now, NULL for rows sealed before today, whose
    // version is still derived from their floor exactly as before.
    expect(rules.sql).toContain(
      'ALTER TABLE public.diamond_choice_rounds ADD COLUMN payout_version integer CHECK(payout_version>=4);'
    );
    expect(rules.sql).toContain(
      'ALTER TABLE public.crash_rounds ADD COLUMN payout_version integer CHECK(payout_version>=4);'
    );
    expect(rules.sql).toContain(
      "''payout_version'',COALESCE(r.payout_version,CASE WHEN r.minimum_payout_chips<=0 THEN 1 WHEN r.minimum_payout_chips=public.fn_diamond_bonus_minimum(r.bet_chips,2) THEN 3 ELSE 2 END)"
    );
    // A contract-4 receipt is recomputed from what was paid, on both shapes:
    // a choice/crash round (bet_chips) and a Plinko run (bet_diamonds).
    const superAddOn = {
      bet_chips: 75,
      bet_diamonds: 7500,
      diamonds_per_chip: 100,
      payout_version: 4,
      minimum_payout_chips: 50,
      bonus: { entry_diamonds: 2500, added_diamonds: 2500, boost_multiplier: 2 },
    };
    expect(validBonusMinimum(superAddOn)).toBe(true);
    expect(validBonusMinimum({ ...superAddOn, minimum_payout_chips: 37.5 })).toBe(false);
    expect(
      validBonusMinimum({
        bet_diamonds: 100,
        diamonds_per_chip: 100,
        payout_version: 4,
        minimum_payout_chips: 0.5,
        paid_diamonds: 100,
        bonus: { entry_diamonds: 100, added_diamonds: 0, boost_multiplier: 1 },
      })
    ).toBe(true);
    // A contract-4 receipt carrying the old tenth is a shaved floor.
    expect(
      validBonusMinimum({
        bet_chips: 1,
        bet_diamonds: 100,
        diamonds_per_chip: 100,
        payout_version: 4,
        minimum_payout_chips: 0.1,
        bonus: { entry_diamonds: 100, added_diamonds: 0, boost_multiplier: 1 },
      })
    ).toBe(false);
    // Versions 1, 2 and 3 keep their contracts, and a Super receipt carrying
    // only the ordinary tenth is still a broken guarantee.
    const stake = 50;
    expect(
      validBonusMinimum({
        bet_chips: stake,
        payout_version: 3,
        minimum_payout_chips: diamondBonusMinimum(stake, 2),
      })
    ).toBe(true);
    expect(
      validBonusMinimum({
        bet_chips: stake,
        payout_version: 2,
        minimum_payout_chips: diamondBonusMinimum(stake, 1),
      })
    ).toBe(true);
    expect(
      validBonusMinimum({
        bet_chips: stake,
        payout_version: 3,
        minimum_payout_chips: diamondBonusMinimum(stake, 1),
      })
    ).toBe(false);
    expect(
      validBonusMinimum({ bet_chips: stake, payout_version: 1, minimum_payout_chips: 0 })
    ).toBe(true);
    expect(
      validBonusMinimum({ bet_chips: stake, payout_version: 5, minimum_payout_chips: 25 })
    ).toBe(false);
  });
});

/**
 * ITEM 7. ONE SETTING PER GAME. Dan, 2026-09-19: "Users should not select
 * difficulty. One setting that is already built into the payout and math."
 * 2026-09-21: the drop VALUE is the player's (R6), the difficulty still is not.
 */
describe('one setting per game: nothing about the payout is a menu', () => {
  it('each choice game names exactly one mode, and the road and the mines are that mode', () => {
    expect(Object.keys(CHOICE_MODE).sort()).toEqual(['crossing', 'mines']);
    expect(new Set(Object.values(CHOICE_MODE)).size).toBe(Object.keys(CHOICE_MODE).length);

    // Donkey Cross under contract 4: twelve streets, the FIRST exactly 0.80x
    // (the certain street: it is worth 0.80B like every other stop, and the
    // survival identity makes it certain with no special case), then strictly
    // increasing to exactly 20x.
    const road = ROAD_LADDERS_V4[CHOICE_MODE.crossing];
    expect(road.length, 'the one road is twelve streets').toBe(12);
    expect(road[0], 'the first street is the certain 0.80x').toBe((CHIP_CENTS * 4) / 5);
    expect(road[road.length - 1], 'the last street is 20x').toBe(TOP_CENTS);
    for (let i = 1; i < road.length; i++) {
      expect(road[i], `street ${i + 1} does not pay more than street ${i}`).toBeGreaterThan(
        road[i - 1]
      );
    }
    expect(roadLadder(CHOICE_MODE.crossing, CHOICE_PAYOUT_VERSION)).toBe(road);
    // The 2026-09-19 road stays exactly what it was for rounds sealed under it.
    const oldRoad = ROAD_LADDERS[CHOICE_MODE.crossing];
    expect(oldRoad[0]).toBeGreaterThan(CHIP_CENTS);
    expect(oldRoad.slice(1)).toEqual(road.slice(1));
    expect(roadLadder(CHOICE_MODE.crossing, 3)).toBe(oldRoad);
    expect(roadLadder(CHOICE_MODE.crossing, undefined)).toBe(oldRoad);

    // Diamond Mines: six, and six is a board the shuffler will actually deal.
    expect(CHOICE_MODE.mines).toBe('6');
    expect([...MINE_COUNTS]).toContain(Number(CHOICE_MODE.mines));
  });

  it('a Plinko table is chosen by the floor, both live tables exist, and the closed ones stay readable', () => {
    for (const version of PLINKO_LIVE_TABLES) {
      expect(PLINKO_TABLES[version], `live table ${version} is not in the mirror`).toBeTruthy();
      expect(PLINKO_TABLES[version].multipliersCents.length).toBe(SLOTS);
    }
    // The two floors are two different tables: a half-floor stake on Super
    // Double would be a 0.72x floor it never paid for.
    expect(plinkoTableForFloor(1, 0.5)).not.toBe(plinkoTableForFloor(0.75, 0.5));
    // The mirror carries the live tables and the closed Diamond table, and the
    // 2026-09-19 boost mapping still names the tables an older receipt was dealt.
    expect(Object.keys(PLINKO_TABLES).map(Number).sort()).toEqual([4, 5, 6]);
    expect(PLINKO_TABLES[plinkoTableVersion(1)].name).toBe('Diamond');
    expect(PLINKO_TABLES[plinkoTableVersion(2)].name).toBe('Super');
  });
});

/**
 * ITEM 8. THE CHOICE GAMES CARRY 0.80 AT EVERY STOPPING POINT, UNDER EVERY
 * FLOOR, WITH THE FIRST STEP CERTAIN. The edge is charged ONCE, at the start,
 * and then every place a player could stop is worth the same 0.80 of the stake.
 *
 * A guaranteed L on a loss is paid for out of the win, so the survival
 * probability is (0.8B - L)/(prize - L). Under contract 4 the first street pays
 * 0.80B, so that probability is exactly 1 there; and the mines board is dealt
 * around the first pick, so P(survive k) = C(18,k-1)/C(24,k-1) and the ladder is
 * L + (0.8B - L) C(24,k-1)/C(18,k-1). Both identities are checked in exact
 * integer arithmetic for all four stake kinds (floors of a half and two thirds),
 * and the 2026-09-19 forms are checked once more for the receipts sealed under
 * them.
 */
describe('Donkey Cross and Diamond Mines are worth 0.80 wherever a player stops', () => {
  /** A spread of real entries in diamonds, on every stake kind. */
  const stakes: { chips: number; floor: number; label: string }[] = [];
  for (const entry of [MIN_DIAMOND_SPIN, 26, 99, 100, 250, 1000, MAX_DIAMOND_SPIN]) {
    for (const kind of STAKE_KINDS) {
      stakes.push({
        chips: kind.stakeOf(entry) / DIAMONDS_PER_CHIP,
        floor: floorCentsOf(kind, entry) / CHIP_CENTS,
        label: `${entry} diamonds ${kind.label}`,
      });
    }
  }

  it('every street is worth exactly 0.80 of the stake, and the first is certain', () => {
    const road = ROAD_LADDERS_V4[CHOICE_MODE.crossing];
    for (const { chips, floor, label } of stakes) {
      const B = BigInt(Math.round(chips * CHIP_CENTS));
      const L = BigInt(Math.round(floor * CHIP_CENTS));
      for (const [i, target] of road.entries()) {
        // P(reach street n) = (0.8B - L)/(prize_n - L), prize_n = B t/100:
        // cleared of fractions, P = 20(4B - 5L) / (Bt - 100L).
        const pNum = 20n * (RETURN_NUM * B - RETURN_DEN * L);
        const pDen = B * BigInt(target) - 100n * L;
        expect(pDen, `${label} street ${target} is not above the floor`).toBeGreaterThan(0n);
        expect(pNum, `${label} floor beats the edge`).toBeGreaterThan(0n);
        // THE FIRST STREET IS CERTAIN: P is exactly 1, and every roll survives it.
        if (i === 0) {
          expect(pNum, `${label} street one is not certain`).toBe(pDen);
          expect(roadSurvives(0n, target, chips, floor)).toBe(true);
          expect(roadSurvives(RANDOM_SPACE - 1n, target, chips, floor)).toBe(true);
        } else {
          expect(pNum, `${label} street ${target} is a certainty`).toBeLessThan(pDen);
        }
        // THE IDENTITY: P x prize + (1 - P) x L === 0.80 x B, in integers.
        expect(
          RETURN_DEN * pNum * B * BigInt(target) + 500n * (pDen - pNum) * L,
          `${label} street ${target} is not worth ${RTP} of the stake`
        ).toBe(400n * pDen * B);
        // roadSurvives implements exactly that probability: the surviving rolls
        // out of RANDOM_SPACE are floor(P x space), both sides of the boundary are
        // pinned, and the grain the floor costs is strictly less than one roll,
        // always the house's way, never the player's.
        const survivors = (pNum * RANDOM_SPACE) / pDen;
        if (i > 0) {
          expect(roadSurvives(survivors - 1n, target, chips, floor), `${label} ${target}`).toBe(
            true
          );
          expect(roadSurvives(survivors, target, chips, floor), `${label} ${target}`).toBe(false);
        }
        expect(pNum * RANDOM_SPACE - survivors * pDen).toBeLessThan(pDen);
      }
    }
    // The 2026-09-19 road keeps verifying under its own ladder and floors.
    const oldRoad = ROAD_LADDERS[CHOICE_MODE.crossing];
    for (const boost of [1, 2] as const) {
      const chips = 1;
      const floor = diamondBonusMinimum(chips, boost);
      const B = 100n;
      const L = BigInt(Math.round(floor * CHIP_CENTS));
      for (const target of oldRoad) {
        const pNum = 20n * (RETURN_NUM * B - RETURN_DEN * L);
        const pDen = B * BigInt(target) - 100n * L;
        expect(RETURN_DEN * pNum * B * BigInt(target) + 500n * (pDen - pNum) * L).toBe(
          400n * pDen * B
        );
        const survivors = (pNum * RANDOM_SPACE) / pDen;
        expect(roadSurvives(survivors - 1n, target, chips, floor)).toBe(true);
        expect(roadSurvives(survivors, target, chips, floor)).toBe(false);
      }
    }
  });

  it('every mines stopping point is the exact closed form around a safe first pick, and worth exactly 0.80', () => {
    const TILES = 25;
    const mines = Number(CHOICE_MODE.mines);
    expect(TILES - mines).toBe(19);
    for (const { chips, floor, label } of stakes) {
      const B = BigInt(Math.round(chips * CHIP_CENTS));
      const L = BigInt(Math.round(floor * CHIP_CENTS));
      for (let picks = 1; picks <= TILES - mines; picks++) {
        // The first pick is safe, so the draw is k-1 picks among the other 24.
        const all = choose(TILES - 1, picks - 1);
        const safe = choose(TILES - 1 - mines, picks - 1);
        const prize = minePrizeV4(chips, mines, picks, floor);
        // THE CLOSED FORM: prize_k === L + (0.8B - L) x C(24,k-1)/C(18,k-1), exact.
        expect(
          prize.numerator * RETURN_DEN * safe,
          `${label} mines pick ${picks} is not L + (0.8B - L) C(24,k-1)/C(18,k-1)`
        ).toBe(
          prize.denominator * (RETURN_DEN * L * safe + (RETURN_NUM * B - RETURN_DEN * L) * all)
        );
        // THE EXPECTATION: safe x prize + (all - safe) x L === 0.80 x B x all.
        expect(
          (safe * prize.numerator + (all - safe) * L * prize.denominator) * RETURN_DEN,
          `${label} mines pick ${picks} is not worth ${RTP} of the stake`
        ).toBe(RETURN_NUM * B * all * prize.denominator);
        // THE FIRST GEM IS CERTAIN AND PAYS EXACTLY 0.80B; every later stop pays more
        // than the floor, so cashing out is always worth more than losing.
        if (picks === 1) {
          expect(safe).toBe(all);
          expect(prize.numerator * RETURN_DEN).toBe(prize.denominator * RETURN_NUM * B);
        }
        expect(prize.numerator).toBeGreaterThan(L * prize.denominator);
      }
    }
    // The 2026-09-19 form, C(25,k)/C(19,k), still prices the boards sealed under it.
    for (const boost of [1, 2] as const) {
      const chips = 1;
      const floor = diamondBonusMinimum(chips, boost);
      const B = 100n;
      const L = BigInt(Math.round(floor * CHIP_CENTS));
      for (let picks = 1; picks <= TILES - mines; picks++) {
        const all = choose(TILES, picks);
        const safe = choose(TILES - mines, picks);
        const prize = minePrize(chips, mines, picks, floor);
        expect((safe * prize.numerator + (all - safe) * L * prize.denominator) * RETURN_DEN).toBe(
          RETURN_NUM * B * all * prize.denominator
        );
      }
    }
  });
});

/**
 * ITEM 8b. CRASH NEVER EXPLODES UNTIL AFTER 1.10x, AND EVERY TARGET IS STILL
 * 0.80B (Dan, 2026-09-21, R3). The point is floored at 110 and cash-out opens at
 * 111. For any x > 1.10, max(raw, 110) >= x iff raw >= x, so the survivors of a
 * target are floor((0.8B - L) 2^48 / (xB/100 - L)) exactly as before, and the
 * value of "always cash at x" is at most one roll's grain under 0.80B, never
 * over. Rounds sealed before contract 4 keep their 1.00x point and 1.01x
 * cash-out, by version.
 */
describe('crash under contract 4: the ship flies to 1.10x, and every cash-out target is worth 0.80', () => {
  it('the point is floored at 1.10x and cash-out opens at 1.11x, by version', () => {
    expect(crashPointFloorCents(4)).toBe(110);
    expect(crashCashoutFloorCents(4)).toBe(111);
    expect(crashPointFloorCents(3)).toBe(100);
    expect(crashCashoutFloorCents(3)).toBe(101);
    expect(crashPointFloorCents(undefined)).toBe(100);
    expect(rules.sql).toContain(
      'SELECT GREATEST(110,floor(100*(p_minimum+(p_bet*.8-p_minimum)*281474976710656/(p_roll+1))/p_bet))::bigint'
    );
    expect(rules.sql).toContain(
      "'  ELSIF p_cashout AND v_now_cents >= (CASE WHEN r.payout_version >= 4 THEN 111 ELSE 101 END) THEN'"
    );
    expect(rules.sql).toContain("''Cash Out Starts At 1.11x''");
    expect(rules.sql).toContain("'  IF v_cap < 111 THEN'");
    // The largest roll seals exactly the floor, and the old floor for old versions.
    for (const { chips, floor } of [
      { chips: 1, floor: 0.5 },
      { chips: 75, floor: 50 },
      { chips: 0.25, floor: 0.13 },
    ]) {
      expect(crashPointCentsFromRoll(RANDOM_SPACE - 1n, chips, floor, 110)).toBe(110);
      expect(crashPointCentsFromRoll(RANDOM_SPACE - 1n, chips, floor, 100)).toBe(100);
    }
  });

  it('every target above 1.10x keeps P(point >= x) = (0.8B - L)/(xB - L) and is worth 0.80B', () => {
    for (const entry of [MIN_DIAMOND_SPIN, 100, 2489, MAX_DIAMOND_SPIN]) {
      for (const kind of STAKE_KINDS) {
        const chips = kind.stakeOf(entry) / DIAMONDS_PER_CHIP;
        const floor = floorCentsOf(kind, entry) / CHIP_CENTS;
        const B = BigInt(Math.round(chips * CHIP_CENTS));
        const L = BigInt(Math.round(floor * CHIP_CENTS));
        for (const target of [111, 112, 150, 200, 500, 1000, TOP_CENTS, 10000]) {
          // survivors = floor((0.8B - L) 2^48 / (B t/100 - L)) = floor(20 (4B - 5L) 2^48 / (B t - 100 L))
          const num = 20n * (RETURN_NUM * B - RETURN_DEN * L) * RANDOM_SPACE;
          const den = B * BigInt(target) - 100n * L;
          const survivors = num / den;
          expect(survivors).toBeGreaterThan(0n);
          expect(survivors).toBeLessThan(RANDOM_SPACE);
          // Both sides of the boundary through the mirror, under the 1.10x floor.
          expect(crashPointCentsFromRoll(survivors - 1n, chips, floor, 110)).toBeGreaterThanOrEqual(
            target
          );
          expect(crashPointCentsFromRoll(survivors, chips, floor, 110)).toBeLessThan(target);
          // The value of always cashing at x, in cents x 2^48 x 100: survivors x B t + (space - survivors) x 100 L.
          const value = survivors * B * BigInt(target) + (RANDOM_SPACE - survivors) * 100n * L;
          const edge = 80n * B * RANDOM_SPACE;
          expect(value, `${kind.label} ${entry} at ${target} pays over 0.80`).toBeLessThanOrEqual(
            edge
          );
          // At most one roll's grain under it: (B t - 100 L) per roll.
          expect(edge - value).toBeLessThan(B * BigInt(target) - 100n * L);
        }
        // Nothing below 1.11x is a target: the ship is still flying at 1.10x.
        expect(crashPointCentsFromRoll(RANDOM_SPACE - 1n, chips, floor, 110)).toBe(110);
      }
    }
  });
});

/**
 * ITEM 9. THE CLIENT MIRRORS AND THE SQL AGREE. src/utils/diamondBonusPayout.ts,
 * src/utils/diamondChoiceMath.ts and src/utils/diamondGamesFairness.ts exist so a
 * page can paint a board before the server's quote arrives - which means they
 * are a SECOND copy of the calibration, and a second copy that drifts is a board
 * that lies. The server's table is the authority; these assertions read the
 * migration as text and require it to spell out exactly what the exported
 * constants say.
 */
describe('the calibration is installed server-side exactly as the client mirrors it', () => {
  it('the Super Double table row is the mirror, slot for slot, and Super and Diamond are the 2026-09-19 rows', () => {
    expect(rules.sql).toContain(
      `VALUES (6,'${SUPER_DOUBLE.name}',${BOARD_ROWS},ARRAY[${SUPER_DOUBLE.multipliersCents.join(',')}],${TOP_CENTS},`
    );
    expect(rules.sql).toContain(
      `IF a.spec_rtp IS DISTINCT FROM ${RTP} OR a.max_multiplier_cents IS DISTINCT FROM ${TOP_CENTS}` +
        ` OR a.hit_rate IS DISTINCT FROM 1.000000 OR a.slots IS DISTINCT FROM ${SLOTS} THEN`
    );
    expect(rules.sql).toContain(
      `WHERE t.version=6)<>${Math.min(...SUPER_DOUBLE.multipliersCents)}`
    );
    for (const version of [4, 5]) {
      const table = PLINKO_TABLES[version];
      expect(calib.sql).toContain(
        `(${version},'${table.name}',${BOARD_ROWS},ARRAY[${table.multipliersCents.join(',')}],${TOP_CENTS},`
      );
    }
  });

  it("the table follows the floor server-side too, and the drop menu is the player's again", () => {
    expect(rules.sql).toContain(
      'WHERE t.activated_at IS NOT NULL AND (SELECT min(m) FROM unnest(t.multipliers_cents) m)*p_bet/100>=p_floor'
    );
    expect(rules.sql).toContain(
      'IF public.fn_plinko_table_for_floor(1,0.5)<>4 OR public.fn_plinko_table_for_floor(0.25,0.13)<>4 OR public.fn_plinko_table_for_floor(75,50)<>6'
    );
    // The player's drop value: the listed values, the whole stake as one drop, and 1..100 drops.
    expect(rules.sql).toContain(
      `(p_denom NOT IN (${PLINKO_DENOMINATIONS.join(',')}) AND p_denom<>p_total) OR p_total%p_denom<>0 OR p_total/p_denom NOT BETWEEN ${PLINKO_MIN_DROPS} AND ${PLINKO_MAX_DROPS} THEN`
    );
    expect(rules.sql).toContain(
      "''Choose A Drop Value That Plays Every Diamond In One To One Hundred Drops''"
    );
    // The ten-drop refusal of 2026-09-19 is removed by name and asserted absent
    // by the migration's own read-back (owner ruling 2026-09-21, R6).
    expect(rules.sql).toContain("''Plinko Plays Ten Drops. Refresh Before You Play''); END IF;'");
    expect(rules.sql).toContain(
      "'Plinko Plays Ten Drops')>0 THEN RAISE EXCEPTION 'Drop values not as designed'"
    );
    // The floor guards the whole run, and the receipt says so as version 4.
    expect(rules.sql).toContain(' paid:=GREATEST(paid,v_minimum);');
    expect(rules.sql).toContain(
      "''payout_version'',4,''paid_diamonds'',public.fn_diamond_game_paid_diamonds(p_total),''drop_count'',v_count,"
    );
    // The door is patched on its exact production preimage, whose md5 the
    // migration pins before it touches anything.
    expect(rules.sql).toContain(
      "('fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer)','81bf3d433fc050b4b1e07386c2e380c7')"
    );
    expect(rules.sql).toContain('Diamond First Step Preimage Changed: %');
    expect(rules.sql).not.toContain('CREATE OR REPLACE FUNCTION public.fn_plinko_bonus_run(');
  });

  it('the v4 road, the mines dealt around the first pick and the one-setting refusal are the mirror', () => {
    const road = ROAD_LADDERS_V4[CHOICE_MODE.crossing];
    expect(rules.sql).toContain(`WHEN '${CHOICE_MODE.crossing}' THEN ARRAY[${road.join(',')}]`);
    expect(rules.sql).toContain(
      `IF cardinality(b)<>${road.length} OR b[1]<>${road[0]} OR b[2]<>${road[1]} OR b[12]<>${road[road.length - 1]}`
    );
    // The 2026-09-19 road is untouched for rounds sealed under it.
    expect(rules.sql).toContain(
      `IF (public.fn_choice_ladder('road'))[1]<>${ROAD_LADDERS.road[0]} THEN RAISE EXCEPTION 'Sealed road ladder lost'`
    );
    // The mines ladder is the same closed form item 8 proves, in SQL, and the
    // board is dealt around the first pick from a domain that names it.
    expect(rules.sql).toContain(
      'out:=array_append(out,p_floor+(p_bet*0.8-p_floor)*public.fn_choice_choose(24,k-1)/public.fn_choice_choose(24-m,k-1));'
    );
    expect(rules.sql).toContain(
      'cells:=ARRAY(SELECT x FROM generate_series(0,24) x WHERE x<>p_first ORDER BY x);'
    );
    expect(rules.sql).toContain("':board:'||p_first||':'||cursor");
    expect(rules.sql).toContain(`IF p_mines NOT IN (${MINE_COUNTS.join(',')}) THEN`);
    // Sealed empty at start; dealt exactly once at the first pick, and only the
    // board the trigger itself recomputes from the row's seed and that pick.
    expect(rules.sql).toContain("IF p_game=''mines'' THEN v_cells:=''{}'';");
    expect(rules.sql).toContain(
      'IF n=0 AND r.payout_version>=4 AND cardinality(r.mine_cells)=0 THEN r.mine_cells:=public.fn_choice_board_v4(r.server_seed,r.client_seed,r.nonce,r.mode::integer,p_cell); END IF;'
    );
    expect(rules.sql).toContain(
      'AND NEW.mine_cells=public.fn_choice_board_v4(OLD.server_seed,OLD.client_seed,OLD.nonce,OLD.mode::integer,NEW.picked[1])'
    );
    expect(rules.sql).toContain("''first_pick'',CASE WHEN r.game=''mines'' THEN r.picked[1] END");
    // A new round may still only name the one setting.
    expect(calib.sql).toContain(
      "IF p_mode IS DISTINCT FROM public.fn_choice_mode(p_game) THEN RETURN jsonb_build_object('ok',false,'error','This Game Has One Setting. Refresh Before You Play'); END IF;"
    );
    expect(rules.sql).toContain(
      `IF cardinality(p)<>${25 - Number(CHOICE_MODE.mines)} OR p[1]<>0.8`
    );
  });
});
