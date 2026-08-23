const fs = require('fs');
let css = fs.readFileSync('src/pages/ClubHomePage.css', 'utf-8');

// Change 220px to 255px
css = css.replace(
  'flex: 0 1 220px;',
  'flex: 0 1 255px;'
);

fs.writeFileSync('src/pages/ClubHomePage.css', css);
