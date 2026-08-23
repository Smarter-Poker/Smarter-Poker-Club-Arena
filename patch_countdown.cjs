const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.tsx', 'utf8');

// Fix LiveCountdown display condition
code = code.replace(
  /e\.kind !== 'cash' && e\.status === 'registering' && e\.startTime && <LiveCountdown time=\{e\.startTime\} \/>/g,
  "e.kind !== 'cash' && ['registering', 'starting_soon'].includes(e.status) && e.startTime && <LiveCountdown time={e.startTime} />"
);

fs.writeFileSync('src/components/lobby/LobbyTable.tsx', code);
