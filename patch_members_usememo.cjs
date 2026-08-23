const fs = require('fs');
const file = 'src/pages/ClubMembersPage.tsx';
let content = fs.readFileSync(file, 'utf8');

// Restore the useMemo one
content = content.replace(
  /const membersWithStatus = useMemo\([\s\S]*?is_online: false, \/\/ Updated via membersWithStatus useMemo[\s\S]*?\}\)\),\n\s*\[members, onlineUserIds\]\n\s*\);/,
  `const membersWithStatus = useMemo(
    () =>
      members.map((m) => ({
        ...m,
        is_online: onlineUserIds.has(m.user_id),
      })),
    [members, onlineUserIds]
  );`
);

fs.writeFileSync(file, content);
