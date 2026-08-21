const fs = require('fs');
let code = fs.readFileSync('src/services/HandHistoryService.ts', 'utf8');
code = code.replace("export const handHistoryService", "}\n\nexport const handHistoryService");
fs.writeFileSync('src/services/HandHistoryService.ts', code);
