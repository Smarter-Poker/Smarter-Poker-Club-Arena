const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.tsx', 'utf-8');

code = code.replace(
  'const hidden = [];',
  'const hidden: typeof entry.rules = [];'
);

fs.writeFileSync('src/components/lobby/LobbyTable.tsx', code);
