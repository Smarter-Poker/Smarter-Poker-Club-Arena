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
import {
  MAX_DIAMOND_SPIN,
  MIN_DIAMOND_SPIN,
  PLINKO_DROPS,
  plinkoDenomination,
} from '../src/utils/bonusGameBudget';
import {
  PLINKO_TABLES,
  diamondBonusMinimum,
  plinkoTableVersion,
  validBonusMinimum,
} from '../src/utils/diamondBonusPayout';
import {
  CHOICE_MODE,
  MINE_COUNTS,
  RANDOM_SPACE,
  ROAD_LADDERS,
  choose,
  minePrize,
  roadSurvives,
} from '../src/utils/diamondChoiceMath';

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
 * THE BOARD, DERIVED. A Plinko board is sixteen rows, so it has seventeen slots
 * and a ball lands in slot k with probability C(16,k)/65536. Nothing here is
 * typed out any more: the row count is read off the live mirror (slots minus
 * one), the weights come from the same `choose` the choice games use, and the
 * space is their sum - which must also be 2^rows, because every path down the
 * board is sixteen independent left/right bits. A hand-typed weight array
 * cannot be checked against anything; this one is checked against two
 * independent derivations at the top of the plinko block below.
 */
const BOARD_ROWS = PLINKO_TABLES[plinkoTableVersion(1)].multipliersCents.length - 1;
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

/** The ordinary table (boost 1) and the Super table (boost 2). Nobody chooses either. */
const DIAMOND = PLINKO_TABLES[plinkoTableVersion(1)];
const SUPER = PLINKO_TABLES[plinkoTableVersion(2)];

/** A probability as a double, from an exact BigInt ratio. */
const ratio = (num: bigint, den: bigint) => Number(num) / Number(den);

/**
 * P(at least one of PLINKO_DROPS drops pays `floorCents` or better), EXACTLY:
 * P(none) is ((space - hit)/space)^drops on the binomial weights, so nothing is
 * simulated and no seed can flatter the answer.
 */
function atLeastOneDrop(table: number[], floorCents: number) {
  let hit = 0n;
  for (let k = 0; k < SLOTS; k++) if (table[k] >= floorCents) hit += WEIGHTS[k];
  const drops = BigInt(PLINKO_DROPS);
  const all = SPACE ** drops;
  return { hit, perDrop: ratio(hit, SPACE), atLeastOne: ratio(all - (SPACE - hit) ** drops, all) };
}

/**
 * THE EXACT DISTRIBUTION OF A WHOLE GAME. A game is PLINKO_DROPS drops of a
 * tenth of the entry, so its return is sum(multiplier cents)/(100 x drops) of
 * the entry, and a total of 100 x PLINKO_DROPS cents is exactly the entry back.
 *
 * 17^10 paths is 2 x 10^12, which is too many to walk and completely
 * unnecessary: collapse the seventeen slots to their seven distinct
 * multipliers, then convolve that cents -> weight map PLINKO_DROPS times in
 * integer cents and BigInt weights. 6,063 reachable totals, ~30ms, and the
 * answer is exact - no sampling, no floating point, no seed.
 *
 * It refuses BY NAME above EXACTLY_MEASURABLE_DROPS instead of grinding: at
 * 500 drops the support is most of a million totals carrying eight-thousand-bit
 * weights, and a test that dies on the runner's timeout reports "timed out",
 * which names no cause (CLAUDE.md 10.86 rule 1 - "I could not tell" is its own
 * outcome). The drop count is asserted before this is ever called.
 */
const EXACTLY_MEASURABLE_DROPS = 20;
function gameDistribution(table: number[]): Map<number, bigint> {
  if (PLINKO_DROPS > EXACTLY_MEASURABLE_DROPS) {
    throw new Error(
      `A ${PLINKO_DROPS}-drop game cannot be measured exactly, which is itself ` +
        `the finding: see the drop-count assertion in this file.`
    );
  }
  const per = new Map<number, bigint>();
  for (let k = 0; k < SLOTS; k++) per.set(table[k], (per.get(table[k]) ?? 0n) + WEIGHTS[k]);
  let dist = new Map<number, bigint>([[0, 1n]]);
  for (let d = 0; d < PLINKO_DROPS; d++) {
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
    expect(SUPER.multipliersCents.length).toBe(SLOTS);
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
  });

  /**
   * ITEM 1 OF THE CALIBRATION CONTRACT (2026-09-19). Both LIVE tables, measured
   * off the exported mirror in integer arithmetic:
   *
   *   - sum over k of C(16,k) x multiplier_cents[k] === 0.80 x 65,536 x 100,
   *     exactly. Measured: 5,242,880 on both, with no remainder to round away;
   *   - both top out at exactly 20.00x - the whole point of the top being 20x
   *     rather than 130x or 1000x is that 20x is inside every award's cover, so
   *     the top slot is a prize that actually gets paid rather than one clipped
   *     to min(table, cap) on the way out;
   *   - NO SLOT PAYS NOTHING. This replaces the dead centre the three closed
   *     tables carried. A dead centre is where the weight is: C(16,8)/65,536 is
   *     the single likeliest slot on the board, so the old tables paid nothing
   *     on one drop in five and 45.5 percent of Moonshot's drops died.
   *
   * Every slot paying is also what the server's own audit demands of a table
   * before it can be activated (hit_rate 1.000000), so this is one rule stated
   * in two languages, and item 9 below proves the two agree.
   */
  it('both live tables return exactly 0.80, top out at exactly 20x, and have no dead slot', () => {
    for (const boost of [1, 2] as const) {
      const version = plinkoTableVersion(boost);
      const table = PLINKO_TABLES[version];
      expect(table, `boost ${boost} names a table that does not exist`).toBeTruthy();
      const m = table.multipliersCents;
      expect(m.length, `${table.name} slots`).toBe(SLOTS);
      let weighted = 0n;
      for (let k = 0; k < SLOTS; k++) {
        weighted += WEIGHTS[k] * BigInt(m[k]);
        // Every slot pays something. This is the pin that the recalibration
        // REPLACED the dead-centre pin with: the closed tables above are
        // asserted to have a zero centre, the live ones to have none.
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
   * ITEM 2. Dan, 2026-09-19: "They must all pay a minimum of 1:1 value even if
   * they lose and don't cash out." A Super award is a doubled stake, so half of
   * it is the player's own spin, and diamondBonusMinimum(stake, 2) is that half.
   *
   * The Super TABLE clears that guarantee on its own: its lowest slot is 0.52x,
   * so the worst possible ten-drop game returns 10 x 0.52 / 10 = 0.52 of the
   * stake, above the 0.50 floor. That matters because a guarantee met by a
   * top-up is a guarantee the player can see was needed; one met by the board
   * is a board on which no batch can lose the spin in the first place. The floor
   * stays, for sub-cent drops where rounding can still bite, but it is never
   * what carries the promise.
   */
  it('the Super table clears its 1:1 guarantee through the multipliers, not the floor', () => {
    // The floor per chip of stake, read from the guarantee function itself
    // rather than typed: a Super award keeps half, which is 50 cents per chip.
    const superFloorCents = Math.round(diamondBonusMinimum(1, 2) * CHIP_CENTS);
    expect(superFloorCents).toBe(CHIP_CENTS / 2);
    const lowest = Math.min(...SUPER.multipliersCents);
    // Measured: the lowest Super slot is 52 cents (0.52x) against a 50-cent floor.
    expect(lowest, 'a Super slot below the guarantee makes the floor load-bearing').toBeGreaterThan(
      superFloorCents - 1
    );
    expect(lowest).toBeGreaterThanOrEqual(superFloorCents);
    // Stated as the whole game: PLINKO_DROPS drops of a tenth, worst case.
    const worstCents = PLINKO_DROPS * lowest;
    const entryCents = PLINKO_DROPS * CHIP_CENTS;
    expect(worstCents * CHIP_CENTS).toBeGreaterThanOrEqual(entryCents * superFloorCents);
    // And the ordinary table is NOT held to this: it is a 0.08x-to-20x board,
    // and its tenth-of-the-stake floor is what a losing ordinary game returns.
    expect(Math.min(...DIAMOND.multipliersCents)).toBeLessThan(superFloorCents);
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
 */
describe('the calibration: the Diamond table can actually be hit, and a game can actually pay', () => {
  /**
   * ITEM 3. REACHABILITY, MEASURED EXACTLY. Dan's sentence was "never saw a 5x,
   * 10x or 20x", so those are the three thresholds. P(no drop at or above t) is
   * ((65,536 - hit)/65,536)^PLINKO_DROPS on the binomial weights, and one minus
   * that is the chance a game shows the player at least one.
   *
   * Measured on the live Diamond table, over PLINKO_DROPS = 10 drops:
   *
   *     5x or better    5,034/65,536 per drop (1 in 13.0)   55.03% per game
   *     10x or better   1,394/65,536 per drop (1 in 47.0)   19.35% per game
   *     20x (the top)     274/65,536 per drop (1 in 239.2)   4.10% per game
   *
   * The bounds are 50%, 15% and 3%: a table flattened enough to lose a fifth of
   * its top-end reach fails. For contrast, the closed Steady table put 20x on
   * 2/65,536 - one drop in 32,768 - which over ten drops is 0.03% a game, or
   * once every three thousand games.
   */
  it('a Diamond game reaches 5x, 10x and 20x often enough to be a game', () => {
    const five = atLeastOneDrop(DIAMOND.multipliersCents, mult(5));
    const ten = atLeastOneDrop(DIAMOND.multipliersCents, mult(10));
    const top = atLeastOneDrop(DIAMOND.multipliersCents, TOP_CENTS);

    // Measured 0.55032576 - above a half, so more games than not show a 5x.
    expect(five.atLeastOne).toBeGreaterThan(0.5);
    // Measured 0.19346045 - the 12x and 20x slots together, about one game in five.
    expect(ten.atLeastOne).toBeGreaterThan(0.15);
    // Measured 0.04103119 - the three outer slots each side, about one game in 24.
    expect(top.atLeastOne).toBeGreaterThan(0.03);

    // The weights themselves, as lower bounds, so a slot quietly demoted out of
    // a band is caught even where the rounded probability stays above its
    // bound. Measured: 5,034 / 1,394 / 274 of 65,536 per drop.
    expect(five.hit, 'the 5x-or-better band lost weight').toBeGreaterThanOrEqual(5034n);
    expect(ten.hit, 'the 10x-or-better band lost weight').toBeGreaterThanOrEqual(1394n);
    expect(top.hit, 'the top band lost weight').toBeGreaterThanOrEqual(274n);
    // And each threshold is at most as easy as the last: a table paying its top
    // on more weight than its 10x band would be arithmetic nonsense.
    expect(top.hit).toBeLessThanOrEqual(ten.hit);
    expect(ten.hit).toBeLessThanOrEqual(five.hit);
    // A per-drop chance stated the way the note to the owner states it.
    expect(top.perDrop).toBeGreaterThan(1 / 240);
  });

  /**
   * ITEM 4. THE EXACT DISTRIBUTION OF A WHOLE GAME. Reachability is not the
   * same question as "does a game pay": ten drops averaging 0.80 can put a 20x
   * on the board and still hand back less than the entry. So the seventeen-slot
   * distribution is convolved PLINKO_DROPS times in integer cents and BigInt
   * weights - 65,536^10 total weight, 6,063 reachable totals - and the whole
   * game's return is read straight off it.
   *
   * A game plays PLINKO_DROPS drops of a tenth of the entry, so a total of
   * 100 x PLINKO_DROPS = 1,000 multiplier cents is exactly the entry back.
   *
   * Measured on the live Diamond table (exact, not sampled):
   *
   *     mean return                     0.800000 of the entry  (exactly)
   *     P(returns at least the entry)   27.978703%
   *     P(returns at least 2x)           6.791272%
   *     P(returns at least 3x)           1.434026%
   *     worst game 0.080x, best 20.000x, 6,063 distinct outcomes
   *
   * The bounds are 20% and 3%. The mean is pinned EXACTLY, in integers, because
   * it is the same 0.80 the whole of the rest of this file protects: a
   * recalibration that bought pay frequency by shaving the edge would pass the
   * two lower bounds and fail here, and one that bought it by paying out more
   * than the game takes in is the faucet this law exists to keep shut.
   */
  it('an exact ten-drop Diamond game returns its entry often enough, and still averages exactly 0.80', () => {
    // A game short enough to measure EXACTLY is part of the contract, not a
    // convenience of the test: the whole defect was a game so long that its
    // outcome was its mean. Refused by name before the convolution runs.
    expect(
      PLINKO_DROPS,
      'a game this long cannot be measured exactly, which is the finding'
    ).toBeLessThanOrEqual(EXACTLY_MEASURABLE_DROPS);
    const dist = gameDistribution(DIAMOND.multipliersCents);
    const all = SPACE ** BigInt(PLINKO_DROPS);
    /** The multiplier-cents total that hands the entry back: ten drops of a tenth. */
    const entryCents = CHIP_CENTS * PLINKO_DROPS;

    // Nothing leaked in the convolution: the weights are a whole probability.
    // Measured: 6,063 reachable totals out of 65,536^10 weight.
    let weight = 0n;
    for (const w of dist.values()) weight += w;
    expect(weight).toBe(all);
    expect(dist.size).toBeGreaterThan(1);

    // Measured 0.27978703 - better than one game in four gets the entry back.
    const back = atLeast(dist, all, entryCents);
    expect(back.p).toBeGreaterThan(0.2);
    // Measured 0.06791272 - about one game in fifteen doubles the entry.
    const twice = atLeast(dist, all, 2 * entryCents);
    expect(twice.p).toBeGreaterThan(0.03);

    // THE EDGE, EXACTLY, ON THE WHOLE GAME. mean = 800 cents against a
    // 1,000-cent entry: mean x 5 === 4 x entry x total weight, in integers.
    let mean = 0n;
    for (const [total, w] of dist) mean += BigInt(total) * w;
    expect(mean * RETURN_DEN).toBe(RETURN_NUM * BigInt(entryCents) * all);
    expect(mean).toBe(
      BigInt(PLINKO_DROPS) * EXACT_RETURN_WEIGHT * SPACE ** BigInt(PLINKO_DROPS - 1)
    );

    // The extremes are the table's own, ten times over: nothing is clipped.
    const totals = [...dist.keys()].sort((a, b) => a - b);
    expect(totals[0]).toBe(PLINKO_DROPS * Math.min(...DIAMOND.multipliersCents));
    expect(totals[totals.length - 1]).toBe(PLINKO_DROPS * TOP_CENTS);
  });

  /**
   * ITEM 5. THE OLD CALIBRATION CANNOT COME BACK. This is the assertion that
   * would have caught the defect, and it is about the DROP COUNT rather than
   * the table.
   *
   * A player's best realistic day has to be a real win. Read off the same exact
   * distribution: the p99 of a ten-drop Diamond game is 3,170 multiplier cents,
   * which is 3.170x the entry - so one game in a hundred is better than three
   * times the money. The bound is 2x.
   *
   * At 500 drops it was arithmetically impossible. Not unlikely - impossible:
   * the drop count does not change the mean, which stays exactly 0.80, but it
   * divides the variance by the count, and the table's own per-drop standard
   * deviation is 222.91 cents. So the distance from 0.80 to 2.00, in standard
   * deviations of the game's return:
   *
   *     PLINKO_DROPS = 10 drops    sd 0.7049 of the entry    1.70 sigma
   *                    100 drops   sd 0.2229                 5.38 sigma
   *                    500 drops   sd 0.0997                12.04 sigma
   *                  2,500 drops   sd 0.0446                26.92 sigma
   *
   * The 500 and 2,500 rows are the game Dan played: a 2,500-diamond award at
   * one to five diamonds a drop. Twelve sigma is not a bad run of luck, it is
   * the law of large numbers, and it is why twenty awards in a row returned the
   * table's mean. Both bounds below are exact integer comparisons on the
   * table's own variance, so they move with the table.
   */
  it('a game is PLINKO_DROPS drops, and PLINKO_DROPS is small enough that a good day is a real win', () => {
    // A game is PLINKO_DROPS drops of a tenth of the entry, and nobody chooses.
    expect(PLINKO_DROPS).toBe(10);
    for (const entry of [MIN_DIAMOND_SPIN * 2, 100, 500, MAX_DIAMOND_SPIN]) {
      expect(plinkoDenomination(entry)! * PLINKO_DROPS).toBe(entry);
    }
    // Anything that is not the tenth has no drop value at all.
    expect(plinkoDenomination(MIN_DIAMOND_SPIN)).toBeNull();

    const dist = gameDistribution(DIAMOND.multipliersCents);
    const all = SPACE ** BigInt(PLINKO_DROPS);
    const entryCents = CHIP_CENTS * PLINKO_DROPS;

    // Measured p99 = 3,170 cents = 3.170x the entry. The bound is 2x: a
    // calibration whose top percentile is not even a doubling is a game whose
    // best realistic day is a loss, which is exactly what 500 drops was.
    const p99 = quantileCents(dist, all, 99, 100);
    expect(p99, 'the best game in a hundred is not even a doubling').toBeGreaterThanOrEqual(
      2 * entryCents
    );
    // And the median is still a loss - this is a 0.80 game, not a giveaway.
    expect(quantileCents(dist, all, 50, 100)).toBeLessThan(entryCents);

    // The variance argument, in exact integers. Var(one drop) in cents^2 is
    // (E[X^2] x space - E[X]^2) / space^2; the return of an N-drop game has
    // variance Var/(100^2 x N), and the squared distance from 4/5 to 2 is
    // (6/5)^2, so sigma^2 to a doubling is 36 x 10,000 x N x varDen / (25 x varNum).
    let m1 = 0n;
    let m2 = 0n;
    for (let k = 0; k < SLOTS; k++) {
      m1 += WEIGHTS[k] * BigInt(DIAMOND.multipliersCents[k]);
      m2 += WEIGHTS[k] * BigInt(DIAMOND.multipliersCents[k]) ** 2n;
    }
    const varNum = m2 * SPACE - m1 * m1;
    const varDen = SPACE * SPACE;
    const sigmaSq = (drops: number) => ({
      num: 36n * 10000n * BigInt(drops) * varDen,
      den: 25n * varNum,
    });
    // At PLINKO_DROPS: 2.898, so 1.70 sigma - a doubling is an ordinary night.
    const now = sigmaSq(PLINKO_DROPS);
    expect(now.num).toBeLessThan(9n * now.den);
    // At MAX_DIAMOND_SPIN / 5 = 500 drops, the old five-diamond drop on the
    // biggest award: 144.9, so 12.04 sigma. Beyond ten sigma the top of the
    // table stops being a prize and becomes a label.
    const old = sigmaSq(MAX_DIAMOND_SPIN / 5);
    expect(old.num).toBeGreaterThan(100n * old.den);
    // And at MAX_DIAMOND_SPIN drops - one diamond a drop, the award Dan
    // actually played twenty of - it is worse still: 26.92 sigma.
    const worst = sigmaSq(MAX_DIAMOND_SPIN);
    expect(worst.num).toBeGreaterThan(old.num);
  });
});

/**
 * ITEM 6. THE GUARANTEE. Dan, 2026-09-19: "They must all pay a minimum of 1:1
 * value even if they lose and don't cash out. That should be displayed before
 * they even start the game."
 *
 * An ordinary award keeps a tenth of its stake on a loss. A Super award is a
 * DOUBLED stake, and it keeps half - and half of a doubled stake is the spin
 * the player paid for, so a Super game returns at least 1:1 of the spin
 * whatever the board does. The three things that can go wrong are all pinned:
 * a floor that is not whole cents cannot be paid; a Super floor below the spin
 * breaks the promise; and a floor at or above 0.80 of the stake is a game with
 * a NEGATIVE edge, which both choice games refuse outright (minePrize and
 * roadSurvives throw when 5L >= 4B) and which would make this whole file's
 * never-pay-more promise false.
 */
describe('the guarantee: a Super game pays the spin back, and no floor beats the edge', () => {
  it('every entry from 25 to 2,500 diamonds keeps whole cents on both stake kinds', () => {
    for (let entry = MIN_DIAMOND_SPIN; entry <= MAX_DIAMOND_SPIN; entry++) {
      for (const boost of [1, 2] as const) {
        // A Super award doubles the entry; at the live bridge rate an entry of
        // N diamonds is a stake of N chip cents, so the stake in cents is the
        // funded diamonds and every comparison below is rate-free.
        const stakeCents = entry * boost;
        const stakeChips = stakeCents / DIAMONDS_PER_CHIP;
        const floor = diamondBonusMinimum(stakeChips, boost);
        const floorCents = Math.round(floor * CHIP_CENTS);

        // Whole cents, and the number really is the cents it rounds to: a
        // fractional chip cent is a prize the ledger cannot pay.
        expect(Number.isSafeInteger(floorCents)).toBe(true);
        expect(Math.abs(floorCents - floor * CHIP_CENTS)).toBeLessThan(1e-9);

        if (boost === 1) {
          // The tenth, rounded up to a whole cent.
          expect(floorCents, `entry ${entry} ordinary floor`).toBe(Math.ceil(stakeCents / 10));
        } else {
          // The half - and therefore exactly the player's own spin, which is
          // `entry` diamonds and so `entry` chip cents. 1:1, to the cent.
          expect(floorCents, `entry ${entry} Super floor`).toBe(Math.ceil(stakeCents / 2));
          expect(floorCents, `entry ${entry} does not return the spin`).toBeGreaterThanOrEqual(
            entry
          );
          expect(floorCents).toBe(entry);
        }

        // Never at or above 0.80 of the stake. Strictly below, because a floor
        // EQUAL to the expected return is a zero-variance game and both choice
        // games refuse it (5L >= 4B throws), and a floor above it is a faucet.
        expect(floorCents * 5, `entry ${entry} boost ${boost} floor beats the edge`).toBeLessThan(
          4 * stakeCents
        );
      }
    }
  });

  it('the two floors are the two payout versions, and an old receipt keeps its own contract', () => {
    // The three figures the migration itself reads back after installing the
    // rule, checked against the client mirror rather than re-typed.
    expect(calib.sql).toContain(
      `IF public.fn_diamond_bonus_minimum(3,2)<>${diamondBonusMinimum(3, 2)}` +
        ` OR public.fn_diamond_bonus_minimum(3)<>${diamondBonusMinimum(3)}` +
        ` OR public.fn_diamond_bonus_minimum(0.25,2)<>${diamondBonusMinimum(0.25, 2)}`
    );
    // Half for a Super award, a tenth otherwise, in one place server-side.
    expect(calib.sql).toContain(
      'SELECT CASE WHEN p_boost=2 THEN ceil(p_bet*50)/100 ELSE ceil(p_bet*10)/100 END'
    );
    // A Super Plinko batch tops up to that half if the drops and their cent
    // rounding somehow fell short, and says so on the receipt as version 3.
    expect(calib.sql).toContain(
      'IF v_boost=2 THEN v_minimum:=public.fn_diamond_bonus_minimum(adm.o_bet_chips,2); paid:=GREATEST(paid,v_minimum); END IF;'
    );
    // Quoted twice over because the patch is a string the migration EXECUTEs.
    expect(calib.sql).toContain(
      "''minimum_payout_chips'',v_minimum,''payout_version'',CASE WHEN v_boost=2 THEN 3 ELSE 1 END,"
    );
    // Version 3 is a round sealed with the Super floor, 2 with the tenth, and 1
    // is an old round that carried no floor at all. The client's receipt check
    // recomputes each against the rule rather than trusting the number, so a
    // receipt whose floor was shaved is refused where a player can see it.
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
    // A Super receipt carrying only the ordinary tenth is a broken guarantee.
    expect(
      validBonusMinimum({
        bet_chips: stake,
        payout_version: 3,
        minimum_payout_chips: diamondBonusMinimum(stake, 1),
      })
    ).toBe(false);
    // And a round sealed before the floor existed keeps its own zero contract.
    expect(
      validBonusMinimum({ bet_chips: stake, payout_version: 1, minimum_payout_chips: 0 })
    ).toBe(true);
  });
});

/**
 * ITEM 7. ONE SETTING PER GAME. Dan, 2026-09-19: "Users should not select
 * difficulty. One setting that is already built into the payout and math."
 *
 * A difficulty selector is not a harmless convenience here: it is how a player
 * ends up on Steady with 1-diamond drops, which is the calibration that
 * produced the twenty dead awards. So every game has exactly one setting, and
 * the setting is derived - from the game for the choice games, from the stake
 * kind for Plinko - never chosen.
 */
describe('one setting per game: nothing about the payout is a menu', () => {
  it('each choice game names exactly one mode, and the road and the mines are that mode', () => {
    // Exactly one mode per choice game, and no two games share one.
    expect(Object.keys(CHOICE_MODE).sort()).toEqual(['crossing', 'mines']);
    expect(Object.values(CHOICE_MODE).every((m) => typeof m === 'string' && m.length > 0)).toBe(
      true
    );
    expect(new Set(Object.values(CHOICE_MODE)).size).toBe(Object.keys(CHOICE_MODE).length);

    // Donkey Cross: twelve streets, strictly increasing, ending at exactly 20x.
    // Twelve because 20x is the cover-safe top and 1.10x is the first street
    // worth crossing for; strictly increasing because a street that pays no
    // more than the one before it is a street nobody would ever cross.
    const road = ROAD_LADDERS[CHOICE_MODE.crossing];
    expect(road.length, 'the one road is twelve streets').toBe(12);
    expect(road[road.length - 1], 'the last street is 20x').toBe(TOP_CENTS);
    expect(road[0], 'the first street must beat the stake').toBeGreaterThan(CHIP_CENTS);
    for (let i = 1; i < road.length; i++) {
      expect(road[i], `street ${i + 1} does not pay more than street ${i}`).toBeGreaterThan(
        road[i - 1]
      );
    }

    // Diamond Mines: six, and six is a board the shuffler will actually deal.
    expect(CHOICE_MODE.mines).toBe('6');
    expect(Number(CHOICE_MODE.mines)).toBe(6);
    expect([...MINE_COUNTS]).toContain(Number(CHOICE_MODE.mines));
  });

  it('a Plinko table is chosen by the stake kind, and both kinds name a table that exists', () => {
    for (const boost of [1, 2] as const) {
      const version = plinkoTableVersion(boost);
      expect(
        PLINKO_TABLES[version],
        `boost ${boost} names table ${version}, which does not exist`
      ).toBeTruthy();
      expect(PLINKO_TABLES[version].multipliersCents.length).toBe(SLOTS);
    }
    // The two stake kinds are two different tables: an ordinary award on the
    // Super board would be a 0.52x floor it never paid for.
    expect(plinkoTableVersion(1)).not.toBe(plinkoTableVersion(2));
    // And nothing else is open. The mirror carries exactly the two live tables.
    expect(Object.keys(PLINKO_TABLES).map(Number).sort()).toEqual(
      [plinkoTableVersion(1), plinkoTableVersion(2)].sort()
    );
  });
});

/**
 * ITEM 8. THE CHOICE GAMES CARRY 0.80 AT EVERY STOPPING POINT, UNDER BOTH
 * FLOORS. The edge is charged ONCE, at the start, and then every place a player
 * could stop is worth the same 0.80 of the stake - which is what makes "cash
 * out anywhere" an honest offer rather than a trap with one good exit.
 *
 * The floor changes the shape of that promise without changing its value: a
 * guaranteed L on a loss has to be paid for out of the win, so the survival
 * probability becomes (0.8B - L)/(prize - L) and the prize ladder becomes
 * L + (0.8B - L) x C(25,k)/C(19,k). Both identities are checked here in exact
 * integer arithmetic, for BOTH floors - the tenth, which the unit suite already
 * covered, and the Super half, which it did not.
 */
describe('Donkey Cross and Diamond Mines are worth 0.80 wherever a player stops', () => {
  /** A spread of real entries in diamonds, at both stake kinds. */
  const stakes: { chips: number; boost: 1 | 2; label: string }[] = [];
  for (const entry of [MIN_DIAMOND_SPIN, 26, 99, 100, 250, 1000, MAX_DIAMOND_SPIN]) {
    for (const boost of [1, 2] as const) {
      stakes.push({
        chips: (entry * boost) / DIAMONDS_PER_CHIP,
        boost,
        label: `${entry} diamonds x${boost}`,
      });
    }
  }

  it('every street is worth exactly 0.80 of the stake, and the roll boundary is that probability', () => {
    const road = ROAD_LADDERS[CHOICE_MODE.crossing];
    for (const { chips, boost, label } of stakes) {
      const floor = diamondBonusMinimum(chips, boost);
      const B = BigInt(Math.round(chips * CHIP_CENTS));
      const L = BigInt(Math.round(floor * CHIP_CENTS));
      for (const target of road) {
        // P(reach street n) = (0.8B - L)/(prize_n - L), with prize_n = B x t/100,
        // cleared of fractions: P = 20(4B - 5L) / (Bt - 100L).
        const pNum = 20n * (RETURN_NUM * B - RETURN_DEN * L);
        const pDen = B * BigInt(target) - 100n * L;
        expect(pDen, `${label} street ${target} is not above the floor`).toBeGreaterThan(0n);
        expect(pNum, `${label} floor beats the edge`).toBeGreaterThan(0n);
        expect(pNum, `${label} street ${target} is a certainty`).toBeLessThan(pDen);

        // THE IDENTITY: P x prize + (1 - P) x L === 0.80 x B, in integers.
        expect(
          RETURN_DEN * pNum * B * BigInt(target) + 500n * (pDen - pNum) * L,
          `${label} street ${target} is not worth ${RTP} of the stake`
        ).toBe(400n * pDen * B);

        // And roadSurvives implements exactly that probability: the number of
        // surviving rolls out of RANDOM_SPACE is floor(P x space), so both
        // sides of the boundary are pinned and the grain the floor costs is
        // strictly less than one roll - always the house's way, never the
        // player's, which is what stops rounding becoming a second edge.
        const survivors = (pNum * RANDOM_SPACE) / pDen;
        expect(roadSurvives(survivors - 1n, target, chips, floor), `${label} ${target}`).toBe(true);
        expect(roadSurvives(survivors, target, chips, floor), `${label} ${target}`).toBe(false);
        expect(pNum * RANDOM_SPACE - survivors * pDen).toBeLessThan(pDen);
      }
    }
  });

  it('every mines stopping point is the exact closed form, and worth exactly 0.80 of the stake', () => {
    // A five-by-five board; minePrize refuses a pick count above 25 - mines,
    // so the one setting's ladder is k = 1..19.
    const TILES = 25;
    const mines = Number(CHOICE_MODE.mines);
    for (const { chips, boost, label } of stakes) {
      const floor = diamondBonusMinimum(chips, boost);
      const B = BigInt(Math.round(chips * CHIP_CENTS));
      const L = BigInt(Math.round(floor * CHIP_CENTS));
      expect(TILES - mines).toBe(19);
      for (let picks = 1; picks <= TILES - mines; picks++) {
        const all = choose(TILES, picks);
        const safe = choose(TILES - mines, picks);
        const prize = minePrize(chips, mines, picks, floor);

        // THE CLOSED FORM: prize_k === L + (0.8B - L) x C(25,k)/C(19,k), exact.
        // Cleared of fractions: prize x 5 x safe === den x (5L x safe + (4B - 5L) x all).
        expect(
          prize.numerator * RETURN_DEN * safe,
          `${label} mines pick ${picks} is not L + (0.8B - L) C(25,k)/C(19,k)`
        ).toBe(
          prize.denominator * (RETURN_DEN * L * safe + (RETURN_NUM * B - RETURN_DEN * L) * all)
        );

        // THE EXPECTATION: P(survive k) = C(19,k)/C(25,k), so
        //   safe x prize + (all - safe) x L === 0.80 x B x all.
        expect(
          (safe * prize.numerator + (all - safe) * L * prize.denominator) * RETURN_DEN,
          `${label} mines pick ${picks} is not worth ${RTP} of the stake`
        ).toBe(RETURN_NUM * B * all * prize.denominator);

        // Every stopping point pays more than the floor it replaces, so
        // cashing out is always worth more than losing.
        expect(prize.numerator).toBeGreaterThan(L * prize.denominator);
      }
    }
  });
});

/**
 * ITEM 9. THE CLIENT MIRRORS AND THE SQL AGREE. src/utils/diamondBonusPayout.ts
 * and src/utils/diamondChoiceMath.ts exist so a page can paint a board before
 * the server's quote arrives - which means they are a SECOND copy of the
 * calibration, and a second copy that drifts is a board that lies. The server's
 * table is the authority; these assertions read the migration as text (the same
 * technique the rest of this file uses) and require it to spell out exactly
 * what the exported constants say.
 */
describe('the calibration is installed server-side exactly as the client mirrors it', () => {
  it('both plinko_tables rows are the mirror, slot for slot', () => {
    for (const boost of [1, 2] as const) {
      const version = plinkoTableVersion(boost);
      const table = PLINKO_TABLES[version];
      expect(calib.sql, `plinko table ${version} (${table.name})`).toContain(
        `(${version},'${table.name}',${BOARD_ROWS},` +
          `ARRAY[${table.multipliersCents.join(',')}],${TOP_CENTS},`
      );
    }
    // The audit gate this migration runs before it will activate either row:
    // exactly 0.800000, top exactly 20x, EVERY SLOT PAYS (hit_rate 1.000000),
    // seventeen slots. That hit_rate is item 1's "no dead slot" in SQL.
    expect(calib.sql).toContain(
      `IF a.spec_rtp IS DISTINCT FROM ${RTP} OR a.max_multiplier_cents IS DISTINCT FROM ${TOP_CENTS}` +
        ` OR a.hit_rate IS DISTINCT FROM 1.000000 OR a.slots IS DISTINCT FROM ${SLOTS} THEN`
    );
    // And the read-back pins the two extremes the mirror carries.
    expect(calib.sql).toContain(
      `WHERE t.version=${plinkoTableVersion(2)})<>${Math.min(...SUPER.multipliersCents)}`
    );
    expect(calib.sql).toContain(
      `WHERE t.version=${plinkoTableVersion(1)})<>${Math.min(...DIAMOND.multipliersCents)}`
    );
    expect(calib.sql).toContain(
      `WHERE t.version=${plinkoTableVersion(1)} AND m=${TOP_CENTS})<>` +
        `${DIAMOND.multipliersCents.filter((c) => c === TOP_CENTS).length}`
    );
  });

  it('fn_plinko_table_version maps the stake kind exactly as plinkoTableVersion does', () => {
    expect(calib.sql).toContain(
      `SELECT CASE WHEN p_boost=2 THEN ${plinkoTableVersion(2)} ELSE ${plinkoTableVersion(1)} END`
    );
    expect(calib.sql).toContain(
      `IF public.fn_choice_mode('mines')<>'${CHOICE_MODE.mines}'` +
        ` OR public.fn_choice_mode('crossing')<>'${CHOICE_MODE.crossing}'` +
        ` OR public.fn_plinko_table_version(2)<>${plinkoTableVersion(2)}` +
        ` OR public.fn_plinko_table_version(1)<>${plinkoTableVersion(1)} THEN`
    );
  });

  it('the ten-drop refusal is PLINKO_DROPS, server-side, and nothing else can be started', () => {
    // The defect, closed at the source: a game is PLINKO_DROPS drops of a tenth
    // of the entry and fn_plinko_bonus_run refuses any other split. There is no
    // drop-value menu left to land a 2,500-diamond award on 2,500 drops.
    expect(calib.sql).toContain(
      `IF p_total IS NULL OR p_total%${PLINKO_DROPS}<>0` +
        ` OR p_denom IS DISTINCT FROM p_total/${PLINKO_DROPS} THEN`
    );
    expect(calib.sql).toContain("'Plinko Plays Ten Drops. Refresh Before You Play'");
    expect(calib.sql).toContain(
      `strpos(pg_get_functiondef('public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer)'::regprocedure),'p_denom IS DISTINCT FROM p_total/${PLINKO_DROPS}')=0`
    );
    // The old drop-value menu is named as the exact text being REMOVED, not
    // merely left unreachable: 1 to 100 diamonds a drop is how a 2,500-diamond
    // award became 2,500 drops.
    expect(calib.sql).toContain('p_denom NOT IN (1,2,4,5,10,20,25,50,100)');
    // And the door is patched on its exact production preimage, whose md5 the
    // migration pins before it touches anything - so a sibling change landing
    // first stops the migration rather than being silently overwritten by it.
    expect(calib.sql).toContain(
      "('fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer)','1b5020f0d055fd1050ba63f28140ae5f')"
    );
    expect(calib.sql).toContain('Diamond One Setting Preimage Changed: %');
    expect(calib.sql).not.toContain('CREATE OR REPLACE FUNCTION public.fn_plinko_bonus_run(');
  });

  it('the one road, the six mines and the one-setting refusal are the mirror', () => {
    const road = ROAD_LADDERS[CHOICE_MODE.crossing];
    expect(calib.sql).toContain(`WHEN '${CHOICE_MODE.crossing}' THEN ARRAY[${road.join(',')}]`);
    expect(calib.sql).toContain(
      `IF cardinality(public.fn_choice_ladder('${CHOICE_MODE.crossing}'))<>${road.length}` +
        ` OR (public.fn_choice_ladder('${CHOICE_MODE.crossing}'))[${road.length}]<>${road[road.length - 1]}`
    );
    expect(calib.sql).toContain(
      `SELECT CASE p_game WHEN 'crossing' THEN '${CHOICE_MODE.crossing}'` +
        ` WHEN 'mines' THEN '${CHOICE_MODE.mines}' END`
    );
    // The sealed mine counts stay readable so settled boards keep verifying,
    // and they are exactly the ones the mirror still knows how to price.
    expect(calib.sql).toContain(`IF p_mines NOT IN (${MINE_COUNTS.join(',')}) THEN`);
    expect(calib.sql).toContain(
      `ELSIF p_game='mines' AND p_mode IN (${MINE_COUNTS.map((m) => `'${m}'`).join(',')}) THEN`
    );
    // And a new round may only name the one setting.
    expect(calib.sql).toContain(
      "IF p_mode IS DISTINCT FROM public.fn_choice_mode(p_game) THEN RETURN jsonb_build_object('ok',false,'error','This Game Has One Setting. Refresh Before You Play'); END IF;"
    );
    // The mines prize ladder is the same closed form item 8 proves, in SQL.
    expect(calib.sql).toContain(
      'out:=array_append(out,floor_chips+(p_bet*0.8-floor_chips)*public.fn_choice_choose(25,k)/public.fn_choice_choose(25-m,k));'
    );
    expect(calib.sql).toContain(
      `IF cardinality(public.fn_choice_prizes('mines','${CHOICE_MODE.mines}',1))<>${25 - Number(CHOICE_MODE.mines)}`
    );
  });
});
