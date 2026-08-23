const fs = require('fs');
const file = 'src/pages/ClubMembersPage.tsx';
let content = fs.readFileSync(file, 'utf8');

// Replace is_online: onlineUserIds.has(m.user_id) with is_online: false
content = content.replace(
  /is_online: onlineUserIds\.has\(m\.user_id\),/g,
  `is_online: false, // Updated via membersWithStatus useMemo`
);

// Remove onlineUserIds from loadMembers dependencies
content = content.replace(
  /\[clubId, user\?\.id, onlineUserIds\]/g,
  `[clubId, user?.id]`
);

fs.writeFileSync(file, content);
