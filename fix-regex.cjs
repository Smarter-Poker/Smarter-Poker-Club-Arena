const fs = require('fs');
let content = fs.readFileSync('server/src/services/HorseFleetRetireSurplus.test.ts', 'utf8');
content = content.replace(/\\n \{2\}\\n/g, '\\n[ ]{2}\\n');
fs.writeFileSync('server/src/services/HorseFleetRetireSurplus.test.ts', content);
