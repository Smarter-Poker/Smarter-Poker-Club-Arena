const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.tsx', 'utf-8');

code = code.replace(
  'Starts in {mins} min...',
  'Starts In {mins} Min...'
);

fs.writeFileSync('src/components/lobby/LobbyTable.tsx', code);
