import fs from 'fs';
const p = '/Users/smarter.poker/Documents/.agent-trees/club-arena/rebuy-pause/src/pages/TablePage.tsx';
let code = fs.readFileSync(p, 'utf8');

code = code.replace(
  'notifyServerRejectRebuy(tableState.id)',
  'GameServerAPI.notifyServerRejectRebuy(tableId)'
);
code = code.replace(
  'if (tableState.id && userId) {',
  'if (tableId && userId) {'
);
fs.writeFileSync(p, code);
