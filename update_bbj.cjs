const fs = require('fs');
const file = 'src/pages/ClubHomePage.css';
let css = fs.readFileSync(file, 'utf8');
css = css.replace(/0 0 12px rgba\(255, 200, 0, 0\.1\)/g, '0 0 12px rgba(255, 255, 255, 0.1)');
fs.writeFileSync(file, css);
