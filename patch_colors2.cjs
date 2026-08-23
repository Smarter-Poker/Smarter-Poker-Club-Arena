const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.css', 'utf8');

code = code.replace(
  /\.lt-mine--wait\s*\{\s*background:\s*var\(--warning-gold,\s*#ffd700\);\s*\}/g,
  '.lt-mine--wait {\n  background: var(--text-secondary, #c8ccd4);\n}'
);

fs.writeFileSync('src/components/lobby/LobbyTable.css', code);
