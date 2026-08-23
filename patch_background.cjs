const fs = require('fs');
let css = fs.readFileSync('src/pages/ClubHomePage.css', 'utf-8');

// Replace .club-home background gradient
css = css.replace(
  '  background: linear-gradient(180deg, #0a0a0f 0%, #1a1a2e 100%);',
  '  background: #000000;'
);

fs.writeFileSync('src/pages/ClubHomePage.css', css);
