const fs = require('fs');
let code = fs.readFileSync('src/components/tournament/BlindLevelProgress.css', 'utf8');

// Replace greys with navy surfaces
code = code.replace(/rgba\(36,\s*37,\s*38/gi, 'rgba(34, 48, 70');
code = code.replace(/rgba\(58,\s*59,\s*60/gi, 'rgba(26, 36, 54');
code = code.replace(/#242526/gi, '#1a2436');
code = code.replace(/#3A3B3C/gi, '#223046');
code = code.replace(/rgba\(255,\s*255,\s*255,\s*0.1\)/g, 'rgba(111, 220, 255, 0.15)'); // more cyan borders
fs.writeFileSync('src/components/tournament/BlindLevelProgress.css', code);
