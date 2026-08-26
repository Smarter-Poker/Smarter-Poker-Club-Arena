import fs from 'fs';

const path = 'public/sw-bus.js';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  "body = payload?.clubName || payload?.clubId || '';",
  "const rawName = payload?.clubName || payload?.clubId || '';\n            body = rawName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');"
);

fs.writeFileSync(path, code);
