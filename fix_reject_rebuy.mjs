import fs from 'fs';
const p = '/Users/smarter.poker/Documents/.agent-trees/club-arena/rebuy-pause/server/src/handlers/reject_rebuy.ts';
let code = fs.readFileSync(p, 'utf8');

code = code.replace(
  'engine.rejectRebuy(user.id);',
  'engine.rejectRebuy(user.userId);'
);
fs.writeFileSync(p, code);
