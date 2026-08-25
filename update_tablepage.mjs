import fs from 'fs';
const p = '/Users/smarter.poker/Documents/.agent-trees/club-arena/rebuy-pause/src/pages/TablePage.tsx';
let code = fs.readFileSync(p, 'utf8');

if (!code.includes('notifyServerRejectRebuy')) {
  // Add import
  code = code.replace(
    "import { notifyServerLeave, submitAction, submitDiscard } from '../services/GameServerAPI';",
    "import { notifyServerLeave, submitAction, submitDiscard, notifyServerRejectRebuy } from '../services/GameServerAPI';"
  );
  
  // Replace onCloseRebuyModal
  const oldCode = "onCloseRebuyModal={() => setShowRebuyModal(false)}";
  const newCode = `onCloseRebuyModal={() => {
          setShowRebuyModal(false);
          if (tableState.id && userId) {
            notifyServerRejectRebuy(tableState.id).catch(console.error);
          }
        }}`;
        
  code = code.replace(oldCode, newCode);
  fs.writeFileSync(p, code);
  console.log("Updated TablePage");
}
