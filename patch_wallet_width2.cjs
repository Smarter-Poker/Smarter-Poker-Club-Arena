const fs = require('fs');
let css = fs.readFileSync('src/pages/ClubHomePage.css', 'utf-8');

css = css.replace(
  'flex: 0 1 255px;',
  'flex: 0 1 260px;'
);

fs.writeFileSync('src/pages/ClubHomePage.css', css);
