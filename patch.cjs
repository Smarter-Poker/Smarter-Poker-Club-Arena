const fs = require('fs');
let code = fs.readFileSync('src/pages/InvitePage.tsx', 'utf8');

// Fix 1: Add alreadyMember to canvas useEffect
code = code.replace(
  /}, \[club\?\.id, club\?\.slug, refCode, user\?\.id\]\);/g,
  "}, [club?.id, club?.slug, refCode, user?.id, alreadyMember]);"
);

fs.writeFileSync('src/pages/InvitePage.tsx', code);
