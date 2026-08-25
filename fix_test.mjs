import fs from 'fs';
const p = '/Users/smarter.poker/Documents/.agent-trees/club-arena/rebuy-pause/tests/unit/GameServerAPI.test.ts';
let code = fs.readFileSync(p, 'utf8');

code = code.replace(
  "'getTableState',",
  "'getTableState',\n          'notifyServerRejectRebuy',"
);
fs.writeFileSync(p, code);
