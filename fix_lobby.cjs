const fs = require('fs');
let code = fs.readFileSync('src/pages/tournament/TournamentLobbyPage.module.css', 'utf8');

// The lobby uses #0a0a0f and #1a1a2e. Let's make it smarter.poker #0d1120 and #1a2436!
code = code.replace(/#0a0a0f/gi, '#0d1120');
code = code.replace(/#1a1a2e/gi, '#1a2436');
code = code.replace(/rgba\(26,\s*26,\s*46/gi, 'rgba(26, 36, 54'); // 1a1a2e rgba to 1a2436 rgba
code = code.replace(/#1a1a2e/gi, '#1a2436');

fs.writeFileSync('src/pages/tournament/TournamentLobbyPage.module.css', code);
