const fs = require('fs');
const file = 'src/pages/ClubMembersPage.tsx';
let content = fs.readFileSync(file, 'utf8');

// First conflict
content = content.replace(
  /<<<<<<< HEAD\n\s*is_online: false, \/\/ Updated via membersWithStatus useMemo\n=======\n\s*is_online: false, \/\/ mapped via useMemo below\n>>>>>>> origin\/main/,
  `is_online: false, // mapped via membersWithStatus useMemo`
);

// Second conflict
content = content.replace(
  /<<<<<<< HEAD\n\s*\[clubId, user\?\.id, isMountedRef, toast\]\n=======\n\s*\[clubId, user\?\.id\]\n>>>>>>> origin\/main/,
  `[clubId, user?.id, isMountedRef, toast]`
);

fs.writeFileSync(file, content);
