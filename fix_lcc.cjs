const fs = require('fs');
let code = fs.readFileSync('src/components/tournament/LiveChipCounts.css', 'utf8');

// Replace orange warning with cyan/blue
code = code.replace(/rgba\(247,\s*147,\s*26/gi, 'rgba(0, 180, 230'); // cyan
code = code.replace(/#F02849/gi, '#ef4444');
code = code.replace(/rgba\(240,\s*40,\s*73/gi, 'rgba(239, 68, 68'); // standard red
code = code.replace(/rgba\(49,\s*162,\s*76/gi, 'rgba(24, 119, 242'); // safe to standard blue

fs.writeFileSync('src/components/tournament/LiveChipCounts.css', code);
