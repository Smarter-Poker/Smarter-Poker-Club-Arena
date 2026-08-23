const fs = require('fs');
let css = fs.readFileSync('src/components/club/ClubBottomNav.module.css', 'utf-8');

css = css.replace(
  '  background: linear-gradient(180deg, rgba(15, 25, 40, 0.98) 0%, rgba(8, 15, 25, 0.99) 100%);',
  '  background: linear-gradient(180deg, #0055ff 0%, #0033aa 100%);'
);

fs.writeFileSync('src/components/club/ClubBottomNav.module.css', css);
