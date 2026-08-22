const fs = require('fs');

function revertGold() {
  const file = 'src/pages/ClubHomePage.css';
  let css = fs.readFileSync(file, 'utf8');
  css = css.replace(
    /\.gold-icon::before {\n  content: '●';\n  color: #3b82f6;/g,
    ".gold-icon::before {\n  content: '●';\n  color: #ffb800;"
  );
  css = css.replace(
    /\.quickprefs__chip\.is-on {\n  background: linear-gradient\(135deg, #3b82f6, #ff9d00\);/g,
    ".quickprefs__chip.is-on {\n  background: linear-gradient(135deg, #3b82f6, #2563eb);"
  );
  css = css.replace(
    /\.game-bar__filter-btn\.is-set {\n  color: #17130a;\n  background: linear-gradient\(135deg, #ffb800, #ff9d00\);/g,
    ".game-bar__filter-btn.is-set {\n  color: #ffffff;\n  background: linear-gradient(135deg, #3b82f6, #2563eb);"
  );
  fs.writeFileSync(file, css);
}

function updateAdvancedFilters() {
  const file = 'src/components/lobby/AdvancedFilters.css';
  let css = fs.readFileSync(file, 'utf8');
  
  // change afx-chip.is-on and afx-tab.is-active
  css = css.replace(/background: linear-gradient\(135deg, #ffb800, #ff9d00\);/g, 'background: linear-gradient(135deg, #3b82f6, #2563eb);');
  css = css.replace(/border-color: #ffb800;/g, 'border-color: #3b82f6;');
  // The color of the text inside .is-on is #17130a, change to white
  css = css.replace(/color: #17130a;/g, 'color: #ffffff;');
  
  fs.writeFileSync(file, css);
}

revertGold();
updateAdvancedFilters();
