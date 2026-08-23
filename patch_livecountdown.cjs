const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.tsx', 'utf8');

code = code.replace(
  /if \(mins <= 0 \|\| mins > 60\) return null;/g,
  "if (isNaN(mins) || mins <= 0 || mins > 60) return null;"
);

fs.writeFileSync('src/components/lobby/LobbyTable.tsx', code);
