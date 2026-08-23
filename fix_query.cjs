const fs = require('fs');
const file = 'src/pages/ClubHomePage.tsx';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  ".eq('union_id', unionId)",
  ".or(`union_id.eq.${unionId},club_id.eq.${unionId}`)"
);

fs.writeFileSync(file, code);
