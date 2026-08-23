const fs = require('fs');
let css = fs.readFileSync('src/pages/ClubHomePage.css', 'utf-8');

// Replace purple tints with neutral dark cool-greys
css = css.replace(/#2a2a3e/g, '#1a1b23');
css = css.replace(/#1a1a2e/g, '#0f1015');

fs.writeFileSync('src/pages/ClubHomePage.css', css);
