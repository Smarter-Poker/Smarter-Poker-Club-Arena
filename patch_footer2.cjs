const fs = require('fs');
let css = fs.readFileSync('src/components/club/ClubBottomNav.module.css', 'utf-8');

// The active tab is currently cyan #00d4ff on a dark background.
// If the background is a solid, distinct blue, we should make the icons white or bright.
// Let's use a rich navy blue for the footer.
css = css.replace(
  '  background: linear-gradient(180deg, #0055ff 0%, #0033aa 100%);',
  '  background: linear-gradient(180deg, #0f4c9c 0%, #06285a 100%);'
);

fs.writeFileSync('src/components/club/ClubBottomNav.module.css', css);
