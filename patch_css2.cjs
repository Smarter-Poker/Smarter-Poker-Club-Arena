const fs = require('fs');
let css = fs.readFileSync('src/components/lobby/AdvancedFilters.css', 'utf-8');

// Replace .afx-chip block
css = css.replace(/\.afx-chip \{[\s\S]*?\}/, `.afx-chip {
  flex-shrink: 0;
  min-height: 36px;
  padding: 0 16px;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.06);
  color: #9aa5b6;
  transition: all 0.2s ease;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}`);

// Replace .afx-chip.is-on block
css = css.replace(/\.afx-chip\.is-on \{[\s\S]*?\}/, `.afx-chip.is-on {
  background: linear-gradient(135deg, #0088ff, #0055ff);
  border-color: rgba(0, 136, 255, 0.75);
  color: #ffffff;
  font-weight: 800;
  box-shadow: 0 0 14px rgba(0, 136, 255, 0.35);
}`);

fs.writeFileSync('src/components/lobby/AdvancedFilters.css', css);
