const fs = require('fs');
const file = 'src/components/admin/ClubMemberManagement.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /\{member\.isBanned \? '' : ''\}/,
  `{member.isBanned ? 'Unban' : 'Ban'}`
);

fs.writeFileSync(file, content);
