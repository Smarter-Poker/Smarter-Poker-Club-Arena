/**
 * Fixture hands for the river one-pair measurement, and the TypeScript answer
 * for them - the parity oracle scripts/dev/test-horse-river-one-pair-calls.sh
 * checks fn_horse_river_one_pair_calls against.
 *
 *     npx tsx scripts/river-one-pair-fixture.ts rows.json expected.json
 *
 * Every shape the SQL and TypeScript readers must agree on is here: the three
 * size classes, a blind defence (call amounts are increments), a dead ante, a
 * live ante, hero bets then faces a raise, a short all-in call of a full-raise
 * all-in, two pair (excluded), pocket pair that hit (excluded), board flush and
 * board straight (excluded), a short board (unreadable), an Omaha row (skipped)
 * and card strings as well as card objects.
 */
import { writeFileSync } from 'node:fs';
import { riverOnePairCalls, type ReviewAction, type ReviewRow } from '../src/benchmark/HoldemLiveMeasure.js';

const H = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';

const act = (userId: string, action: string, stage: string, amount?: number, extra: Record<string, unknown> = {}): ReviewAction & Record<string, unknown> =>
  ({ userId, action, stage, ...(amount === undefined ? {} : { amount }), ...extra });
const card = (s: string) => ({ rank: s[0], suit: { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' }[s[1]] });
const cards = (s: string) => s.split(' ').map(card);
const pre = (openerTotal: number, callerIncrement: number) => [
  act(V, 'sb', 'preflop', 0.5), act(H, 'bb', 'preflop', 1),
  act(V, 'raise', 'preflop', openerTotal), act(H, 'call', 'preflop', callerIncrement),
];
const row = (hole: unknown, board: unknown, actions: unknown[], net: number, variant = 'nlh'): ReviewRow & { horse_user_id: string } => ({
  horse_user_id: H,
  game_variant: variant,
  net_bb: net,
  hole_cards: hole,
  board,
  actions: actions as ReviewAction[],
});

const rows: Array<ReviewRow & { horse_user_id: string }> = [
  // pot 6: river bet 1 = 0.167 small, won
  row(cards('As Kd'), cards('Ah 7c 2d 9s Jc'), [...pre(3, 2), act(V, 'bet', 'river', 1), act(H, 'call', 'river', 1)], 25),
  // small, lost
  row(cards('As Kd'), cards('Ah 7c 2d 9s Jc'), [...pre(3, 2), act(V, 'bet', 'river', 1), act(H, 'call', 'river', 1)], -25),
  // pot 6: bet 3 = 0.5 medium, lost (overpair)
  row(cards('Qs Qd'), cards('Jh 7c 2d 9s 3c'), [...pre(3, 2), act(V, 'bet', 'river', 3), act(H, 'call', 'river', 3)], -30),
  // pot 6: bet 6 = 1.0 large, won (underpair)
  row(cards('5s 5d'), cards('Jh 7c 2d 9s 3c'), [...pre(3, 2), act(V, 'bet', 'river', 6), act(H, 'call', 'river', 6)], 40),
  // blind defence three-way: sb 0.5 bb 1, S opens 3, both call increments -> pot 9; S bets 3 = 0.333 small
  row(cards('As Kd'), cards('Ah 7c 2d 9s Jc'), [
    act(V, 'sb', 'preflop', 0.5), act(H, 'bb', 'preflop', 1), act(S, 'raise', 'preflop', 3),
    act(V, 'call', 'preflop', 2.5), act(H, 'call', 'preflop', 2),
    act(S, 'bet', 'river', 3), act(H, 'call', 'river', 3),
  ], 20),
  // dead antes 1+1 pooled, raise 4 / call 4 -> pot 10; bet 5 = 0.5 medium
  row(cards('As Kd'), cards('Ah 7c 2d 9s Jc'), [
    act(V, 'ante', 'preflop', 1, { dead: true }), act(H, 'ante', 'preflop', 1, { dead: true }),
    act(V, 'raise', 'preflop', 4), act(H, 'call', 'preflop', 4),
    act(V, 'bet', 'river', 5), act(H, 'call', 'river', 5),
  ], 21),
  // live ante joins the level: sb 0.5, bb 1 + ante 1 = 2; raise to 6, call 4 -> 12; bet 5 = 0.417 medium
  row(cards('As Kd'), cards('Ah 7c 2d 9s Jc'), [
    act(V, 'sb', 'preflop', 0.5), act(H, 'bb', 'preflop', 1), act(H, 'ante', 'preflop', 1, { dead: false }),
    act(V, 'raise', 'preflop', 6), act(H, 'call', 'preflop', 4),
    act(V, 'bet', 'river', 5), act(H, 'call', 'river', 5),
  ], -22),
  // hero bets 2 into 2, villain raises to 6: 6/4 = 1.5, raised -> large
  row(cards('As Kd'), cards('Ah 7c 2d 9s Jc'), [
    act(V, 'sb', 'preflop', 0.5), act(H, 'bb', 'preflop', 1), act(V, 'call', 'preflop', 0.5),
    act(H, 'bet', 'river', 2), act(V, 'raise', 'river', 6), act(H, 'call', 'river', 4),
  ], 23),
  // short all-in call of a full-raise all-in: pot 6, jam 30 -> 5.0 large
  row(cards('As Kd'), cards('Ah 7c 2d 9s Jc'), [...pre(3, 2), act(V, 'all_in', 'river', 30, { isFullRaise: true }), act(H, 'all_in', 'river', 9)], -24),
  // two pair: not one pair
  row(cards('As 7d'), cards('Ah 7c 2d 9s Jc'), [...pre(3, 2), act(V, 'bet', 'river', 6), act(H, 'call', 'river', 6)], 40),
  // pocket pair that hit (a set): excluded
  row(cards('As Ad'), cards('Ah 7c 2d 9s Jc'), [...pre(3, 2), act(V, 'bet', 'river', 6), act(H, 'call', 'river', 6)], 40),
  // board flush: excluded
  row(cards('As Kd'), cards('Ah 7h 2h 9h Jh'), [...pre(3, 2), act(V, 'bet', 'river', 6), act(H, 'call', 'river', 6)], 40),
  // board straight: excluded
  row(cards('Ts 2d'), cards('6h 7c 8d 9s Tc'), [...pre(3, 2), act(V, 'bet', 'river', 6), act(H, 'call', 'river', 6)], 40),
  // wheel with a hole card: excluded
  row(cards('As 2d'), cards('Ah 3c 4d 5s Jc'), [...pre(3, 2), act(V, 'bet', 'river', 6), act(H, 'call', 'river', 6)], 40),
  // no river call (fold): not counted
  row(cards('As Kd'), cards('Ah 7c 2d 9s Jc'), [...pre(3, 2), act(V, 'bet', 'river', 6), act(H, 'fold', 'river')], -3),
  // card strings instead of objects: small, won
  row(['As', 'Kd'], ['Ah', '7c', '2d', '9s', 'Jc'], [...pre(3, 2), act(V, 'bet', 'river', 1), act(H, 'call', 'river', 1)], 26),
  // short board: unreadable
  row(cards('As Kd'), cards('Ah 7c 2d'), [...pre(3, 2)], 30),
  // Omaha: skipped entirely (neither considered nor unreadable)
  row(cards('As Kd'), cards('Ah 7c 2d 9s Jc'), [...pre(3, 2), act(V, 'bet', 'river', 1), act(H, 'call', 'river', 1)], 25, 'plo4'),
];

const [rowsOut, expectedOut] = process.argv.slice(2);
if (!rowsOut || !expectedOut) throw new Error('usage: river-one-pair-fixture.ts rows.json expected.json');
writeFileSync(rowsOut, JSON.stringify(rows));
const expected = riverOnePairCalls(rows);
writeFileSync(expectedOut, JSON.stringify(expected, null, 2));
process.stdout.write(`${rows.length} fixture rows; expected ${JSON.stringify(expected.cells)} considered=${expected.consideredRows} unreadable=${expected.unreadableRows}\n`);
