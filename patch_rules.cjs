const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.tsx', 'utf-8');
code = code.replace(
  '{RULE_ABBR[r.key] || r.label.slice(0, 4)}',
  '{r.label}'
);
// Also increase the slice limit just in case
code = code.replace(
  'const shown = entry.rules.slice(0, 4);',
  'const shown = entry.rules;'
);
code = code.replace(
  'const hidden = entry.rules.slice(4);',
  'const hidden = [];'
);
fs.writeFileSync('src/components/lobby/LobbyTable.tsx', code);
