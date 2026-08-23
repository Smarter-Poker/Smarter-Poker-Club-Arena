const fs = require('fs');
let code = fs.readFileSync('src/pages/tournament/TournamentDetails.tsx', 'utf8');

// Yellows / Golds
code = code.replace(/#fbbf24/g, '#6fdcff');
code = code.replace(/251,191,36/g, '111,220,255');
code = code.replace(/rgba\(255,\s*215,\s*0/g, 'rgba(111,220,255');
code = code.replace(/#ffd700/g, '#6fdcff');

// Purples
code = code.replace(/#a78bfa/g, '#00b4e6');

// Mint Greens
code = code.replace(/#34d399/g, '#00b4e6');

fs.writeFileSync('src/pages/tournament/TournamentDetails.tsx', code);
