const fs = require('fs');
let css = fs.readFileSync('src/pages/ClubHomePage.css', 'utf-8');

// Replace .quickprefs__chip block
css = css.replace(/\.quickprefs__chip \{[\s\S]*?\}/, `.quickprefs__chip {
  flex-shrink: 0;
  height: 32px;
  padding: 0 14px;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.06);
  color: #9aa5b6;
  transition: all 0.2s ease;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}`);

// Replace .quickprefs__chip.is-on block
css = css.replace(/\.quickprefs__chip\.is-on \{[\s\S]*?\}/, `.quickprefs__chip.is-on {
  background: linear-gradient(135deg, #0088ff, #0055ff);
  border-color: rgba(0, 136, 255, 0.75);
  color: #ffffff;
  font-weight: 800;
  box-shadow: 0 0 14px rgba(0, 136, 255, 0.35);
}`);

// Replace .quickprefs__more block (make it pill shaped too)
css = css.replace(/\.quickprefs__more \{[\s\S]*?\}/, `.quickprefs__more {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
  color: #3b82f6;
  transition: all 0.2s ease;
  cursor: pointer;
}`);

fs.writeFileSync('src/pages/ClubHomePage.css', css);
