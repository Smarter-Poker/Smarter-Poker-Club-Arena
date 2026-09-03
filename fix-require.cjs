const fs = require('fs');
let content = fs.readFileSync('server/src/services/HorseConcurrency.test.ts', 'utf8');
content = `import * as fs from 'fs';\nimport * as path from 'path';\n` + content.replace(/require\('fs'\)/g, 'fs').replace(/require\('path'\)/g, 'path');
fs.writeFileSync('server/src/services/HorseConcurrency.test.ts', content);
