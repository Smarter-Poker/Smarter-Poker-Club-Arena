const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.tsx', 'utf8');

code = code.replace(
  "{ ...COL_PLAYERS, label: 'Enrolled' }",
  "{ ...COL_PLAYERS, label: 'Enrolled', hideOnMobile: true }"
);

fs.writeFileSync('src/components/lobby/LobbyTable.tsx', code);
