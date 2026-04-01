/**
 * ENGINE MATH VERIFICATION — Tests critical poker engine functions
 * Run: node server/test-engine-math.mjs
 *
 * This is NOT a unit test framework. It's a direct mathematical verification
 * of the engine functions against known correct results.
 */

import { fileURLToPath } from 'url';
import path from 'path';

// We'll test the compiled JS output directly
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════════════════════
// TEST INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ❌ FAIL: ${message}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    passed++;
    console.log(`  ✅ ${message} (${actual} ≈ ${expected}, diff=${diff.toFixed(6)})`);
  } else {
    failed++;
    failures.push(`${message}: expected ${expected}, got ${actual}, diff=${diff}`);
    console.log(`  ❌ FAIL: ${message}: expected ${expected}, got ${actual}, diff=${diff}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT ENGINE FUNCTIONS (from compiled output)
// ═══════════════════════════════════════════════════════════════════════════════

let PokerEngine;
try {
  PokerEngine = await import('./dist/engine/PokerEngine.js');
} catch (e) {
  console.error('Failed to import PokerEngine. Make sure server is built (npx tsc).');
  console.error(e.message);
  process.exit(1);
}

const {
  calculatePots,
  calculateBettingState,
  validateAction,
  calculateRake,
  determineWinners,
  evaluateHand,
  evaluateOmahaHand,
  evaluateOmahaLowHand,
  compareHands,
  HAND_RANKINGS,
} = PokerEngine;

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1: SIDE POT CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ TEST 1: Side Pot Calculation ═══');

// Scenario: 3 players, Player A all-in for 50, B all-in for 100, C calls 100
{
  const players = [
    { seat: 1, user_id: 'A', totalInvested: 50, bet: 50, stack: 0, is_folded: false, is_all_in: true, cards: [] },
    { seat: 3, user_id: 'B', totalInvested: 100, bet: 100, stack: 0, is_folded: false, is_all_in: true, cards: [] },
    { seat: 5, user_id: 'C', totalInvested: 100, bet: 100, stack: 200, is_folded: false, is_all_in: false, cards: [] },
  ];
  const pots = calculatePots(players);

  // Main pot: 50 × 3 = 150 (A, B, C eligible)
  // Side pot: 50 × 2 = 100 (B, C eligible)
  assert(pots.length === 2, 'Three players, two all-in levels → 2 pots');
  assert(pots[0].amount === 150, `Main pot = 150 (got ${pots[0]?.amount})`);
  assert(pots[0].eligiblePlayers.length === 3, `Main pot: 3 eligible (got ${pots[0]?.eligiblePlayers?.length})`);
  assert(pots[1].amount === 100, `Side pot = 100 (got ${pots[1]?.amount})`);
  assert(pots[1].eligiblePlayers.length === 2, `Side pot: 2 eligible (got ${pots[1]?.eligiblePlayers?.length})`);
  assert(!pots[1].eligiblePlayers.includes('A'), 'Player A NOT eligible for side pot');
}

// Scenario: Folded player contributed chips
{
  const players = [
    { seat: 1, user_id: 'A', totalInvested: 50, bet: 50, stack: 0, is_folded: false, is_all_in: true, cards: [] },
    { seat: 2, user_id: 'F', totalInvested: 30, bet: 30, stack: 100, is_folded: true, is_all_in: false, cards: [] },
    { seat: 3, user_id: 'B', totalInvested: 100, bet: 100, stack: 200, is_folded: false, is_all_in: false, cards: [] },
  ];
  const pots = calculatePots(players);

  // Folded player contributes to pot amounts but is NOT eligible
  // Level 30: 30 × 3 = 90, eligible: A, B (F folded)
  // Level 50: 20 × 2 = 40, eligible: A, B  → merged with first (same eligible)
  // Level 100: 50 × 1 = 50, eligible: B only
  const mainPotAmount = pots[0]?.amount;
  const sidePotAmount = pots[1]?.amount;
  assert(pots.length === 2, `Folded player scenario → 2 pots (got ${pots.length})`);
  assert(mainPotAmount === 130, `Main pot = 130 (30×3=90 + 20×2=40, merged, got ${mainPotAmount})`);
  assert(sidePotAmount === 50, `Side pot = 50 (50×1, got ${sidePotAmount})`);
  assert(!pots[0].eligiblePlayers.includes('F'), 'Folded player NOT eligible');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2: ODD CHIP DISTRIBUTION — FIX-226
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ TEST 2: Odd Chip Distribution (FIX-226) ═══');

{
  // 3 players split a $1.01 pot. Dealer at seat 5.
  // Each gets $0.33, remainder $0.02 goes clockwise from dealer.
  // Clockwise from 5: seat 1 (dist 6), seat 3 (dist 8), seat 5 is dealer (dist 10)
  // Wait — dealer distance is 0. After dealer, clockwise: seat 1 (dist=1+seatMax), seat 3 (dist=3+...).
  // Actually with maxSeat calculation: maxSeat = max(1,3,5,5)+1 = 6
  // seat 1 dist = (1 - 5 + 60) % 6 = 56 % 6 = 2
  // seat 3 dist = (3 - 5 + 60) % 6 = 58 % 6 = 4
  // seat 5 dist = (5 - 5 + 60) % 6 = 60 % 6 = 0
  // Sorted by dist: seat 5 (0), seat 1 (2), seat 3 (4)
  // First 2 get extra cent: seat 5 gets $0.34, seat 1 gets $0.34, seat 3 gets $0.33

  const players = [
    { seat: 1, user_id: 'P1', cards: [{ rank: 'A', suit: 'hearts' }, { rank: 'K', suit: 'hearts' }], is_folded: false, is_all_in: false, totalInvested: 100, bet: 0, stack: 100, is_sitting_out: false },
    { seat: 3, user_id: 'P3', cards: [{ rank: 'A', suit: 'diamonds' }, { rank: 'K', suit: 'diamonds' }], is_folded: false, is_all_in: false, totalInvested: 100, bet: 0, stack: 100, is_sitting_out: false },
    { seat: 5, user_id: 'P5', cards: [{ rank: 'A', suit: 'clubs' }, { rank: 'K', suit: 'clubs' }], is_folded: false, is_all_in: false, totalInvested: 100, bet: 0, stack: 100, is_sitting_out: false },
  ];

  // All have identical hands (AK suited). Board: 2h 3h 4d 5d 7c
  const communityCards = [
    { rank: '2', suit: 'hearts' }, { rank: '3', suit: 'hearts' }, { rank: '4', suit: 'diamonds' },
    { rank: '5', suit: 'diamonds' }, { rank: '7', suit: 'clubs' }
  ];

  const pots = [{ amount: 1.01, eligiblePlayers: ['P1', 'P3', 'P5'] }];
  const dealerSeat = 5;

  const winners = determineWinners(players, communityCards, pots, 'nlh', dealerSeat);

  assert(winners.length === 3, `3-way split → 3 winners (got ${winners.length})`);

  const totalDistributed = winners.reduce((sum, w) => sum + w.amount, 0);
  assertClose(totalDistributed, 1.01, 0.001, `Total distributed = $1.01`);

  // Find who gets the extra cents
  const p5Win = winners.find(w => w.userId === 'P5')?.amount ?? 0;
  const p1Win = winners.find(w => w.userId === 'P1')?.amount ?? 0;
  const p3Win = winners.find(w => w.userId === 'P3')?.amount ?? 0;

  // Clockwise from dealer seat 5: P5 (dist 0) gets first odd cent, P1 (dist 2) gets second
  assertClose(p5Win, 0.34, 0.001, `P5 (clockwise first) gets $0.34`);
  assertClose(p1Win, 0.34, 0.001, `P1 (clockwise second) gets $0.34`);
  assertClose(p3Win, 0.33, 0.001, `P3 (clockwise third) gets $0.33`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 3: RAKE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ TEST 3: Rake Calculation ═══');

{
  const config = { percent: 10, cap: 5, noFlopNoDrop: true };

  // No flop → no rake
  assert(calculateRake(100, false, config) === 0, 'No flop → 0 rake');

  // $50 pot, 10% = $5, capped at $5
  assert(calculateRake(50, true, config) === 5, '$50 pot → $5 rake (at cap)');

  // $30 pot, 10% = $3, under cap
  assert(calculateRake(30, true, config) === 3, '$30 pot → $3 rake');

  // $100 pot, 10% = $10, capped at $5
  assert(calculateRake(100, true, config) === 5, '$100 pot → $5 rake (capped)');

  // Player count caps
  const configWithPlayerCaps = {
    percent: 10,
    cap: 10,
    noFlopNoDrop: true,
    playerCountCaps: [
      { players: 2, cap: 5 },
      { players: 3, cap: 6.7 },
      { players: 4, cap: 10 },
    ],
  };

  // 2 players, $100 pot → 10% = $10 → capped at $5 (HU cap)
  assert(calculateRake(100, true, configWithPlayerCaps, 2) === 5, 'HU cap: $100 pot → $5');

  // 3 players, $100 pot → 10% = $10 → capped at $6.70
  assertClose(calculateRake(100, true, configWithPlayerCaps, 3), 6.7, 0.01, '3-handed cap: $100 pot → $6.70');

  // 5 players, $100 pot → 10% = $10 → capped at $10 (full cap, 5 >= 4)
  assert(calculateRake(100, true, configWithPlayerCaps, 5) === 10, '5-handed cap: $100 pot → $10');

  // Fractional pot: $0.75, 10% = $0.07 (truncated)
  assertClose(calculateRake(0.75, true, config), 0.07, 0.001, '$0.75 pot → $0.07 rake (truncated)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 4: HAND EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ TEST 4: Hand Evaluation ═══');

{
  // Royal Flush
  const royalFlush = evaluateHand(
    [{ rank: 'A', suit: 'hearts' }, { rank: 'K', suit: 'hearts' }],
    [{ rank: 'Q', suit: 'hearts' }, { rank: 'J', suit: 'hearts' }, { rank: 'T', suit: 'hearts' },
     { rank: '2', suit: 'clubs' }, { rank: '3', suit: 'diamonds' }]
  );
  assert(royalFlush.ranking === HAND_RANKINGS.ROYAL_FLUSH, `Royal flush = ranking ${HAND_RANKINGS.ROYAL_FLUSH} (got ${royalFlush.ranking})`);

  // Straight Flush
  const straightFlush = evaluateHand(
    [{ rank: '9', suit: 'spades' }, { rank: '8', suit: 'spades' }],
    [{ rank: '7', suit: 'spades' }, { rank: '6', suit: 'spades' }, { rank: '5', suit: 'spades' },
     { rank: '2', suit: 'clubs' }, { rank: '3', suit: 'diamonds' }]
  );
  assert(straightFlush.ranking === HAND_RANKINGS.STRAIGHT_FLUSH, `Straight flush = ranking ${HAND_RANKINGS.STRAIGHT_FLUSH} (got ${straightFlush.ranking})`);

  // Four of a kind
  const quads = evaluateHand(
    [{ rank: 'A', suit: 'hearts' }, { rank: 'A', suit: 'diamonds' }],
    [{ rank: 'A', suit: 'clubs' }, { rank: 'A', suit: 'spades' }, { rank: 'K', suit: 'hearts' },
     { rank: '2', suit: 'clubs' }, { rank: '3', suit: 'diamonds' }]
  );
  assert(quads.ranking === HAND_RANKINGS.FOUR_OF_A_KIND, `Quads = ranking ${HAND_RANKINGS.FOUR_OF_A_KIND} (got ${quads.ranking})`);

  // Full House
  const fullHouse = evaluateHand(
    [{ rank: 'K', suit: 'hearts' }, { rank: 'K', suit: 'diamonds' }],
    [{ rank: 'K', suit: 'clubs' }, { rank: 'Q', suit: 'spades' }, { rank: 'Q', suit: 'hearts' },
     { rank: '2', suit: 'clubs' }, { rank: '3', suit: 'diamonds' }]
  );
  assert(fullHouse.ranking === HAND_RANKINGS.FULL_HOUSE, `Full house = ranking ${HAND_RANKINGS.FULL_HOUSE} (got ${fullHouse.ranking})`);

  // Flush
  const flush = evaluateHand(
    [{ rank: 'A', suit: 'hearts' }, { rank: 'J', suit: 'hearts' }],
    [{ rank: '9', suit: 'hearts' }, { rank: '5', suit: 'hearts' }, { rank: '2', suit: 'hearts' },
     { rank: 'K', suit: 'clubs' }, { rank: '3', suit: 'diamonds' }]
  );
  assert(flush.ranking === HAND_RANKINGS.FLUSH, `Flush = ranking ${HAND_RANKINGS.FLUSH} (got ${flush.ranking})`);

  // Straight
  const straight = evaluateHand(
    [{ rank: 'T', suit: 'hearts' }, { rank: '9', suit: 'diamonds' }],
    [{ rank: '8', suit: 'clubs' }, { rank: '7', suit: 'spades' }, { rank: '6', suit: 'hearts' },
     { rank: '2', suit: 'clubs' }, { rank: '3', suit: 'diamonds' }]
  );
  assert(straight.ranking === HAND_RANKINGS.STRAIGHT, `Straight = ranking ${HAND_RANKINGS.STRAIGHT} (got ${straight.ranking})`);

  // Wheel (A-2-3-4-5)
  const wheel = evaluateHand(
    [{ rank: 'A', suit: 'hearts' }, { rank: '5', suit: 'diamonds' }],
    [{ rank: '4', suit: 'clubs' }, { rank: '3', suit: 'spades' }, { rank: '2', suit: 'hearts' },
     { rank: 'K', suit: 'clubs' }, { rank: 'Q', suit: 'diamonds' }]
  );
  assert(wheel.ranking === HAND_RANKINGS.STRAIGHT, `Wheel = Straight (got ${wheel.ranking})`);
  // Wheel kickers should be [5, 4, 3, 2, 1] (ace plays low)
  assert(wheel.kickers[0] === 5, `Wheel high card = 5 (got ${wheel.kickers[0]})`);

  // Two Pair
  const twoPair = evaluateHand(
    [{ rank: 'A', suit: 'hearts' }, { rank: 'K', suit: 'diamonds' }],
    [{ rank: 'A', suit: 'clubs' }, { rank: 'K', suit: 'spades' }, { rank: '7', suit: 'hearts' },
     { rank: '2', suit: 'clubs' }, { rank: '3', suit: 'diamonds' }]
  );
  assert(twoPair.ranking === HAND_RANKINGS.TWO_PAIR, `Two Pair = ranking ${HAND_RANKINGS.TWO_PAIR} (got ${twoPair.ranking})`);

  // High Card
  const highCard = evaluateHand(
    [{ rank: 'A', suit: 'hearts' }, { rank: '8', suit: 'diamonds' }],
    [{ rank: '6', suit: 'clubs' }, { rank: '4', suit: 'spades' }, { rank: '2', suit: 'hearts' },
     { rank: 'K', suit: 'clubs' }, { rank: 'T', suit: 'diamonds' }]
  );
  assert(highCard.ranking === HAND_RANKINGS.HIGH_CARD, `High Card = ranking ${HAND_RANKINGS.HIGH_CARD} (got ${highCard.ranking})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 5: SHORT DECK RANKINGS
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ TEST 5: Short Deck Hand Rankings ═══');

{
  // In Short Deck: Flush beats Full House
  const sdFlush = evaluateHand(
    [{ rank: 'A', suit: 'hearts' }, { rank: 'J', suit: 'hearts' }],
    [{ rank: '9', suit: 'hearts' }, { rank: '7', suit: 'hearts' }, { rank: '6', suit: 'hearts' },
     { rank: 'K', suit: 'clubs' }, { rank: 'Q', suit: 'diamonds' }],
    true // shortDeck
  );
  const sdFullHouse = evaluateHand(
    [{ rank: 'K', suit: 'hearts' }, { rank: 'K', suit: 'diamonds' }],
    [{ rank: 'K', suit: 'clubs' }, { rank: 'Q', suit: 'spades' }, { rank: 'Q', suit: 'hearts' },
     { rank: '7', suit: 'clubs' }, { rank: '8', suit: 'diamonds' }],
    true // shortDeck
  );

  assert(sdFlush.ranking > sdFullHouse.ranking, `Short Deck: Flush (${sdFlush.ranking}) > Full House (${sdFullHouse.ranking})`);
  assert(compareHands(sdFlush, sdFullHouse) > 0, 'Short Deck: compareHands(flush, fullHouse) > 0');

  // Short Deck wheel: A-6-7-8-9
  const sdWheel = evaluateHand(
    [{ rank: 'A', suit: 'hearts' }, { rank: '9', suit: 'diamonds' }],
    [{ rank: '8', suit: 'clubs' }, { rank: '7', suit: 'spades' }, { rank: '6', suit: 'hearts' },
     { rank: 'K', suit: 'clubs' }, { rank: 'Q', suit: 'diamonds' }],
    true
  );
  assert(sdWheel.ranking === HAND_RANKINGS.STRAIGHT, `Short Deck Wheel = Straight (got ${sdWheel.ranking})`);
  assert(sdWheel.kickers[0] === 9, `Short Deck Wheel high = 9 (got ${sdWheel.kickers[0]})`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 6: BETTING STATE + VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ TEST 6: Betting State + Validation ═══');

{
  // NLH: pot=100, currentBet=20, playerBet=0, BB=10, lastRaise=10
  const state = calculateBettingState(100, 20, 0, 10, 10, false);
  assert(state.toCall === 20, `toCall = 20 (got ${state.toCall})`);
  assert(state.minRaise === 10, `minRaise = 10 (got ${state.minRaise})`);
  assert(state.maxRaise === undefined, `NLH maxRaise = undefined (got ${state.maxRaise})`);

  // PLO: pot=100, currentBet=20, playerBet=0, BB=10, lastRaise=10
  const ploState = calculateBettingState(100, 20, 0, 10, 10, true);
  assert(ploState.maxRaise === 120, `PLO maxRaise = pot + toCall = 100 + 20 = 120 (got ${ploState.maxRaise})`);

  // Validate: fold always valid
  assert(validateAction('fold', undefined, 100, state).valid, 'Fold always valid');

  // Validate: check when toCall > 0 → invalid
  assert(!validateAction('check', undefined, 100, state).valid, 'Cannot check with outstanding bet');

  // Validate: call when toCall > 0 → valid
  assert(validateAction('call', undefined, 100, state).valid, 'Call is valid');

  // Validate: raise below minRaise → invalid (unless all-in)
  assert(!validateAction('raise', 25, 100, state).valid, 'Raise to 25 (raise of 5 < minRaise 10) invalid');

  // Validate: raise to 30 (raise of 10 = minRaise) → valid
  assert(validateAction('raise', 30, 100, state).valid, 'Raise to 30 (raise of 10 = minRaise) valid');

  // Validate: PLO raise beyond pot limit → invalid
  const ploRaiseResult = validateAction('raise', 200, 100, ploState);
  assert(!ploRaiseResult.valid, `PLO raise to 200 (raise=180 > maxRaise 120) invalid`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 7: OMAHA HAND EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ TEST 7: Omaha Hand Evaluation ═══');

{
  // Omaha: Must use exactly 2 from hand, 3 from board
  // Hand: Ah Kh Qd Jd, Board: Th 9h 8h 2c 3c
  // Best: Ah Kh from hand + Th 9h 8h from board = A-high flush
  // NOT: Ah Kh Qd from hand (can't use 3)
  const omahaHand = evaluateOmahaHand(
    [{ rank: 'A', suit: 'hearts' }, { rank: 'K', suit: 'hearts' }, { rank: 'Q', suit: 'diamonds' }, { rank: 'J', suit: 'diamonds' }],
    [{ rank: 'T', suit: 'hearts' }, { rank: '9', suit: 'hearts' }, { rank: '8', suit: 'hearts' }, { rank: '2', suit: 'clubs' }, { rank: '3', suit: 'clubs' }]
  );
  assert(omahaHand.ranking === HAND_RANKINGS.FLUSH, `Omaha: Flush (got ${omahaHand.name})`);

  // Omaha Hi-Lo: Board: 2h 4d 5c 8s Kh
  // Hand: Ah 3h 7d Jc
  // Best low: A(1) 3 from hand + 2 4 5 from board = [5,4,3,2,1] — the nut low
  const omahaLow = evaluateOmahaLowHand(
    [{ rank: 'A', suit: 'hearts' }, { rank: '3', suit: 'hearts' }, { rank: '7', suit: 'diamonds' }, { rank: 'J', suit: 'clubs' }],
    [{ rank: '2', suit: 'hearts' }, { rank: '4', suit: 'diamonds' }, { rank: '5', suit: 'clubs' }, { rank: '8', suit: 'spades' }, { rank: 'K', suit: 'hearts' }]
  );
  assert(omahaLow !== null, 'Omaha Lo: qualifying low exists');
  assert(omahaLow.kickers[0] === 5, `Omaha Lo: high kicker = 5 (nut low) (got ${omahaLow?.kickers?.[0]})`);
  assert(omahaLow.kickers[4] === 1, `Omaha Lo: low kicker = 1 (ace) (got ${omahaLow?.kickers?.[4]})`);

  // No qualifying low: Hand: Ah 9h Td Jd, Board: 2c 4d 6s Kh Qh
  // Using A,9 from hand + 2,4,6 from board = [9,6,4,2,1] — 9 > 8, not qualifying
  const noLow = evaluateOmahaLowHand(
    [{ rank: 'A', suit: 'hearts' }, { rank: '9', suit: 'hearts' }, { rank: 'T', suit: 'diamonds' }, { rank: 'J', suit: 'diamonds' }],
    [{ rank: '2', suit: 'clubs' }, { rank: '4', suit: 'diamonds' }, { rank: '6', suit: 'spades' }, { rank: 'K', suit: 'hearts' }, { rank: 'Q', suit: 'hearts' }]
  );
  assert(noLow === null, 'No qualifying Omaha Lo (9-high not <= 8)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 8: HI-LO SPLIT WITH INTEGER CENTS
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ TEST 8: Hi-Lo Split with Integer Cents ═══');

{
  // PLO8 scenario: pot = $10.01, 2 players
  // Player H has best high, Player L has best low
  // Hi half = ceil(10.01/2) = 5.01, Lo half = floor(10.01/2) = 5.00
  // Actually: potCents = 1001, loCents = trunc(1001/2) = 500 → $5.00
  // hiPotAmount = (1001 - 500) / 100 = $5.01

  const players = [
    { seat: 1, user_id: 'H', cards: [
      { rank: 'A', suit: 'hearts' }, { rank: 'K', suit: 'hearts' },
      { rank: 'Q', suit: 'hearts' }, { rank: 'J', suit: 'hearts' }
    ], is_folded: false, is_all_in: false, totalInvested: 50, bet: 0, stack: 100, is_sitting_out: false },
    { seat: 3, user_id: 'L', cards: [
      { rank: 'A', suit: 'diamonds' }, { rank: '2', suit: 'diamonds' },
      { rank: '3', suit: 'clubs' }, { rank: '4', suit: 'clubs' }
    ], is_folded: false, is_all_in: false, totalInvested: 50, bet: 0, stack: 100, is_sitting_out: false },
  ];

  // Board: 5h 6d 7c Kd Qs — H has straight (using Q J from hand + 5 6 7 from board? No...)
  // Actually let me make this simpler: Board: 5c 6d 8s Kc Qs
  // H: Ah Kh Qh Jh → best high = KK with Q kicker (using K from hand + K from board + Q + ...)
  // L: Ad 2d 3c 4c → best low = A(1) 2 from hand + 5 6 8 from board = [8,6,5,2,1] — qualifying
  // H: best high hand uses Ah Kh from hand + Kc Qs 8s from board = pair of kings A kicker
  // L: best high uses Ad 4c from hand + Kc Qs 8s = A-high (worse than pair)
  // So H wins high, L wins low

  const board = [
    { rank: '5', suit: 'clubs' }, { rank: '6', suit: 'diamonds' }, { rank: '8', suit: 'spades' },
    { rank: 'K', suit: 'clubs' }, { rank: 'Q', suit: 'spades' }
  ];

  const pots = [{ amount: 10.01, eligiblePlayers: ['H', 'L'] }];
  const winners = determineWinners(players, board, pots, 'plo8', 0);

  const hWin = winners.find(w => w.userId === 'H')?.amount ?? 0;
  const lWin = winners.find(w => w.userId === 'L')?.amount ?? 0;

  assert(winners.length === 2, `Hi-Lo: 2 winners (got ${winners.length})`);
  assertClose(hWin + lWin, 10.01, 0.001, `Hi-Lo total = $10.01`);
  assertClose(hWin, 5.01, 0.01, `Hi winner gets $5.01 (odd cent to high)`);
  assertClose(lWin, 5.00, 0.01, `Lo winner gets $5.00`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════════════');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log(`  ❌ ${f}`));
}
console.log('═══════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
