import fs from 'fs';
const p = '/Users/smarter.poker/Documents/.agent-trees/club-arena/rebuy-pause/server/src/router.ts';
let code = fs.readFileSync(p, 'utf8');

if (!code.includes('handleRejectRebuy')) {
  // Add import
  code = code.replace(
    "import { handleLeave } from './handlers/leave.js';",
    "import { handleLeave } from './handlers/leave.js';\nimport { handleRejectRebuy } from './handlers/reject_rebuy.js';"
  );
  
  // Add to router map
  code = code.replace(
    "'POST /leave': (req, res) => handleLeave(req, res, deps),",
    "'POST /leave': (req, res) => handleLeave(req, res, deps),\n    'POST /reject_rebuy': (req, res) => handleRejectRebuy(req, res, deps),"
  );
  fs.writeFileSync(p, code);
  console.log("Updated router");
}
