const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.tsx', 'utf-8');

code = code.replace(
  'e.kind === \'tourn\'',
  'e.kind !== \'cash\''
);

fs.writeFileSync('src/components/lobby/LobbyTable.tsx', code);
