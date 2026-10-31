// BB facing a BTN open (2.5bb) and SB facing a BTN open, 6-max cash 100bb, balanced.
import { HorseLogic, type HorseGameStateV2 } from '../src/engine/HorseLogic.js';
import { seedFastRandom } from '../src/engine/HorseEval.js';
import { HAND_CLASSES } from '../src/engine/HorseGtoOpeningRanges.js';
import type { Card, SeatPlayer, ActionRecord } from '../src/types.js';
const S = ['spades', 'hearts', 'diamonds', 'clubs'];
function run(heroSeat: number, openerSeat: number, mode: 'cash' | 'tournament') {
  let call = 0,
    raise = 0;
  for (const h of HAND_CLASSES) {
    for (let s = 0; s < 12; s++) {
      const su = (s * 3) % 4;
      const s2 = h.cls[2] === 's' ? su : (su + 1 + (s % 3)) % 4;
      const hole = [
        { rank: h.cls[0], suit: S[su] },
        { rank: h.cls[1], suit: S[s2] },
      ] as Card[];
      const players: SeatPlayer[] = [];
      const hist: ActionRecord[] = [];
      let ts = 1;
      for (let seat = 1; seat <= 6; seat++) {
        const bet = seat === 1 ? 1 : seat === 2 ? 2 : seat === openerSeat ? 5 : 0;
        players.push({
          seat,
          user_id: 'p' + seat,
          username: 'p' + seat,
          stack: 200 - bet,
          bet,
          totalInvested: bet,
          cards: seat === heroSeat ? hole : [],
          is_folded: false,
          is_all_in: false,
          is_sitting_out: false,
          is_horse: true,
        } as SeatPlayer);
      }
      for (const seat of [3, 4, 5, 6, 1, 2]) {
        if (seat === heroSeat) break;
        if (seat === openerSeat) {
          hist.push({
            seat,
            userId: 'p' + seat,
            action: 'raise',
            amount: 5,
            timestamp: ts++,
            stage: 'preflop',
            isFullRaise: true,
          } as ActionRecord);
          continue;
        }
        players[seat - 1].is_folded = true;
        hist.push({
          seat,
          userId: 'p' + seat,
          action: 'fold',
          amount: 0,
          timestamp: ts++,
          stage: 'preflop',
        } as ActionRecord);
      }
      const gs = {
        players,
        communityCards: [],
        pot: 8,
        currentBet: 5,
        minRaise: 3,
        lastRaise: 3,
        stage: 'preflop',
        gameVariant: 'nlh',
        bigBlind: 2,
        dealerSeat: 6,
        actionHistory: hist,
        gameMode: mode,
        ante: 0,
        format: mode === 'cash' ? 'cash' : 'mtt',
      } as unknown as HorseGameStateV2;
      seedFastRandom(s * 31 + h.cls.charCodeAt(0) * 7 + h.cls.length);
      const d = HorseLogic.decide(players[heroSeat - 1], gs, 'balanced', {}, {
        mind: false,
        telemetry: false,
      } as never);
      if (d.action === 'call') call += h.combos / 12;
      else if (d.action === 'raise' || d.action === 'all_in') raise += h.combos / 12;
    }
  }
  return `call ${((100 * call) / 1326).toFixed(1)} 3bet ${((100 * raise) / 1326).toFixed(1)}`;
}
console.log('BB vs BTN open 2.5x cash:', run(2, 6, 'cash'));
console.log('SB vs BTN open 2.5x cash:', run(1, 6, 'cash'));
console.log('BTN vs CO open 2.5x cash:', run(6, 5, 'cash'));
console.log('BB vs UTG open 2.5x cash:', run(2, 3, 'cash'));
process.exit(0);
