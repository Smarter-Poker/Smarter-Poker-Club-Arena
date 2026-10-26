import { soundService } from '../services/SoundService';

/** One accepted player_action event selects one cue; seat/tab ownership stays with TablePage. */
export function playPlayerActionSound(action: string, amount: number, bigBlind: number): void {
  switch (action.toLowerCase()) {
    case 'all_in':
    case 'allin':
      soundService.playAllIn();
      break;
    case 'bet':
    case 'raise':
      soundService.playRaise(amount, bigBlind);
      break;
    case 'call':
      soundService.playChips();
      break;
    case 'check':
      soundService.playCheck();
      break;
    case 'fold':
      soundService.playFold();
      break;
    case 'discard':
      soundService.playDiscard();
      break;
  }
}
