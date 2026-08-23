const fs = require('fs');
const file = 'src/pages/ClubMembersPage.tsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /\[clubId, user\?\.id\]\n\s*\);/,
  `[clubId, user?.id, isMountedRef, toast]
  );`
);

fs.writeFileSync(file, content);
