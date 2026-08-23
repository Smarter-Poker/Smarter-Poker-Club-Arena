const fs = require('fs');
let code = fs.readFileSync('src/pages/CashierTradePage.module.css', 'utf8');

// Replace purples with standard Smarter.Poker greys/blacks
code = code.replace(/#14101f/g, '#1a1e24');
code = code.replace(/#0d0a16/g, '#111418');
code = code.replace(/#171226/g, '#222831');
code = code.replace(/#1a1528/g, '#2a303c');
code = code.replace(/rgba\(13, 10, 22/g, 'rgba(17, 20, 24');
// Some specific blues from previous agent (e.g. 2b3a5c) can stay as they are poker blues, or make them standard.

// Replace yellows with Smarter.Poker neon blue / golds if required, but user said "REMOVE ALL THE PURPLE AND YELLOW", and "Smarter.Poker color schema".
// Neon Blue: #00d2ff
code = code.replace(/#ffb800/g, '#00d2ff');
code = code.replace(/#f8d264/g, '#33dbff');
code = code.replace(/#eab308/g, '#00a3cc');
code = code.replace(/rgba\(255, 184, 0/g, 'rgba(0, 210, 255');

fs.writeFileSync('src/pages/CashierTradePage.module.css', code);
console.log("Success");
