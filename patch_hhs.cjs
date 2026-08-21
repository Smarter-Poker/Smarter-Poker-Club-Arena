const fs = require('fs');
let code = fs.readFileSync('src/services/HandHistoryService.ts', 'utf8');

const targetStart = "  /**\n   * Save a hand history record.";
const endMatch = "\nexport const handHistoryService = new HandHistoryServiceClass();";

const startIdx = code.indexOf(targetStart);
const endIdx = code.indexOf(endMatch);

code = code.substring(0, startIdx) + code.substring(endIdx);
fs.writeFileSync('src/services/HandHistoryService.ts', code);
