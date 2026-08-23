const fs = require('fs');
let code = fs.readFileSync('src/pages/ClubHomePage.css', 'utf8');

code = code.replace(
  /\.game-bar__types \{[\s\S]*?padding-block: 6px;[\s\S]*?\}/,
  `.game-bar__types {
  flex: 1;
  min-width: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 3px;
  overflow: visible;
  padding-block: 6px;
}`
);

code = code.replace(
  /\.game-bar__types::-webkit-scrollbar \{[\s\S]*?\}/,
  ``
);

code = code.replace(
  /\.game-bar__type \{[\s\S]*?transition:[\s\S]*?ease;[\s\n]*\}/,
  `.game-bar__type {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 2px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.06);
  color: #9aa5b6;
  font-size: 0.65rem;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}`
);

fs.writeFileSync('src/pages/ClubHomePage.css', code);
