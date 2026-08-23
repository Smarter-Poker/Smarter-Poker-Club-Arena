const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.css', 'utf8');

code = code.replace(
  /\.lt-gtd\s*\{\s*color:\s*var\(--warning-gold,\s*#ffd700\);\s*\}/g,
  '.lt-gtd {\n  color: var(--text-secondary, #c8ccd4);\n}'
);

code = code.replace(
  /\.lt-status--waitlist\s*\{\s*color:\s*var\(--warning-gold,\s*#ffd700\);\s*border-color:\s*rgba\(255,\s*215,\s*0,\s*0\.3\);\s*background:\s*rgba\(255,\s*215,\s*0,\s*0\.07\);\s*\}/g,
  '.lt-status--waitlist {\n  color: var(--text-secondary, #c8ccd4);\n  border-color: rgba(255, 255, 255, 0.1);\n  background: rgba(255, 255, 255, 0.04);\n}'
);

code = code.replace(
  /\.lt-status--late_reg\s*\{\s*color:\s*var\(--warning-gold,\s*#ffd700\);\s*border-color:\s*rgba\(255,\s*215,\s*0,\s*0\.35\);\s*background:\s*rgba\(255,\s*215,\s*0,\s*0\.08\);\s*\}/g,
  '.lt-status--late_reg {\n  color: var(--text-secondary, #c8ccd4);\n  border-color: rgba(255, 255, 255, 0.1);\n  background: rgba(255, 255, 255, 0.04);\n}'
);

code = code.replace(
  /\.lt-status--starting_soon\s*\{\s*color:\s*#ffb020;\s*border-color:\s*rgba\(255,\s*176,\s*32,\s*0\.35\);\s*background:\s*rgba\(255,\s*176,\s*32,\s*0\.08\);\s*\}/g,
  '.lt-status--starting_soon {\n  color: var(--text-secondary, #c8ccd4);\n  border-color: rgba(255, 255, 255, 0.1);\n  background: rgba(255, 255, 255, 0.04);\n}'
);

fs.writeFileSync('src/components/lobby/LobbyTable.css', code);
