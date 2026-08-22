const fs = require('fs');
const file = 'src/pages/ClubHomePage.tsx';
let code = fs.readFileSync(file, 'utf8');

// 1. Fix tableQuery
code = code.replace(
  "tableQuery.or(`union_id.eq.${unionId},and(club_id.eq.${resolvedId},is_private.eq.true)`);",
  "tableQuery.or(`union_id.eq.${unionId},club_id.eq.${unionId},and(club_id.eq.${resolvedId},is_private.eq.true)`);"
);

// 2. Fix belongsInTableList
code = code.replace(
  "if (row.union_id === unionId) return true;",
  "if (row.union_id === unionId || row.club_id === unionId) return true;"
);

// 3. Fix belongsInTournamentList
code = code.replace(
  "if (row.union_id === unionId) return true;",
  "if (row.union_id === unionId || row.club_id === unionId) return true;"
);

fs.writeFileSync(file, code);
