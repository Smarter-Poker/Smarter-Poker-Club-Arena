import fs from 'fs';
const p = '/Users/smarter.poker/Documents/.agent-trees/club-arena/rebuy-pause/src/services/GameServerAPI.ts';
let code = fs.readFileSync(p, 'utf8');

code = code.replace(
  '  showHand,\n  submitDiscard, // FIX 120: Crazy Pineapple\n};',
  '  showHand,\n  submitDiscard, // FIX 120: Crazy Pineapple\n  notifyServerRejectRebuy,\n};'
);
fs.writeFileSync(p, code);
