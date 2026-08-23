const fs = require('fs');
let content = fs.readFileSync('src/components/club/CashierClubSwitcher.module.css', 'utf8');

content = content.replace(/rgba\(24,\s*25,\s*26,\s*0\.6\)/g, 'rgba(19, 27, 40, 0.6)');
content = content.replace(/rgba\(36,\s*37,\s*38,\s*0\.98\)/g, 'rgba(26, 36, 54, 0.98)');
content = content.replace(/rgba\(28,\s*29,\s*30,\s*0\.98\)/g, 'rgba(13, 17, 32, 0.98)');
content = content.replace(/#4599ff/g, '#6fdcff');
content = content.replace(/rgba\(69,\s*153,\s*255/g, 'rgba(111, 220, 255');
content = content.replace(/#b0b3b8/g, '#8892a4');
content = content.replace(/#e4e6eb/g, '#e8eaf0');

fs.writeFileSync('src/components/club/CashierClubSwitcher.module.css', content, 'utf8');
