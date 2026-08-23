const fs = require('fs');
let css = fs.readFileSync('src/pages/ClubHomePage.css', 'utf-8');

// Change @media (max-width: 420px) to @media (max-width: 480px)
css = css.replace(
  '@media (max-width: 420px) {',
  '@media (max-width: 480px) {'
);

fs.writeFileSync('src/pages/ClubHomePage.css', css);
