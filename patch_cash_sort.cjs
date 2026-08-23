const fs = require('fs');
let code = fs.readFileSync('src/pages/ClubHomePage.tsx', 'utf8');

code = code.replace(
  /case 'recommended':\s*default:\s*return rows\.sort\(\s*\(a, b\) => cashRank\(a\) - cashRank\(b\) \|\| cmpStakes\(a, b\) \|\| cmpPlayers\(a, b\) \|\| cmpName\(a, b\)\s*\);/g,
  `case 'recommended':
      default:
        return rows.sort((a, b) => cmpStakes(a, b) || cmpPlayers(a, b) || cmpName(a, b));`
);

fs.writeFileSync('src/pages/ClubHomePage.tsx', code);
