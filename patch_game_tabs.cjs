const fs = require('fs');
let code = fs.readFileSync('src/pages/ClubHomePage.tsx', 'utf8');

code = code.replace(
  "{ key: 'ALL', label: 'All Games' },",
  "{ key: 'ALL', label: 'ALL' },"
);
code = code.replace(
  "{ key: 'OMAHA', label: 'Omaha' },",
  "{ key: 'OMAHA', label: 'PLO' },"
);
code = code.replace(
  "{ key: 'LIMIT', label: 'Limit' },",
  "{ key: 'LIMIT', label: 'LMT' },"
);
code = code.replace(
  "{ key: 'SPIN', label: 'Spins' },",
  "{ key: 'SPIN', label: 'SPIN' },"
);
code = code.replace(
  "{ key: 'SNG', label: 'Heads Up' },",
  "{ key: 'SNG', label: 'SNG' },"
);
fs.writeFileSync('src/pages/ClubHomePage.tsx', code);
