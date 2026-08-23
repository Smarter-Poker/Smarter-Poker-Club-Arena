const fs = require('fs');
let css = fs.readFileSync('src/pages/ClubHomePage.css', 'utf-8');

css = css.replace(
  '.club-home::before {\n  content: \'\';\n  position: fixed;\n  inset: 0;',
  '.club-home::before {\n  display: none;\n  content: \'\';\n  position: fixed;\n  inset: 0;'
);

fs.writeFileSync('src/pages/ClubHomePage.css', css);
