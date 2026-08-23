const fs = require('fs');
const file = 'src/pages/ClubHomePage.css';
let code = fs.readFileSync(file, 'utf8');

// Fix avatar size
code = code.replace(
  /\.lobby-club__avatar\s*\{\s*width:\s*220px;\s*height:\s*220px;/g,
  '.lobby-club__avatar {\n  width: 64px;\n  height: 64px;'
);

fs.writeFileSync(file, code);
