const fs = require('fs');
const file = 'src/services/MembershipService.ts';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/catch \(_e\) \{/, 'catch (e) {');
fs.writeFileSync(file, content);
