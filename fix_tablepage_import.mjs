import fs from 'fs';
const p = '/Users/smarter.poker/Documents/.agent-trees/club-arena/rebuy-pause/src/pages/TablePage.tsx';
let code = fs.readFileSync(p, 'utf8');

code = code.replace(
  "import { notifyServerLeave, submitAction, submitDiscard, notifyServerRejectRebuy } from '../services/GameServerAPI';",
  "import { notifyServerLeave, submitAction, submitDiscard } from '../services/GameServerAPI';"
);
fs.writeFileSync(p, code);
