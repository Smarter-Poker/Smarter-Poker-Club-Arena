const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.tsx', 'utf-8');

code = code.replace(
  'color: \'#ef4444\', fontWeight: 600, marginRight: \'8px\', fontStyle: \'italic\'',
  'color: \'#f59e0b\', fontWeight: 700, marginRight: \'8px\', letterSpacing: \'0.02em\''
);

fs.writeFileSync('src/components/lobby/LobbyTable.tsx', code);
