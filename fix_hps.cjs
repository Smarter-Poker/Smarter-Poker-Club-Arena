const fs = require('fs');
const file = 'src/services/HandPersistenceService.ts';
let code = fs.readFileSync(file, 'utf8');

// There is a stray } around line 384
code = code.replace(/\/\/ to avoid duplicate records and incorrect bbj_contribution \(always 0 here\)\.\n    \}\n\n    \/\/ Reset state — ready for next hand/g, "// to avoid duplicate records and incorrect bbj_contribution (always 0 here).\n\n    // Reset state — ready for next hand");

fs.writeFileSync(file, code);
