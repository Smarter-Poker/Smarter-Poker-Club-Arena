const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.tsx', 'utf8');

// For th
code = code.replace(
  "className={\`\${col.className || ''}\${col.sortable ? ' is-sortable' : ''}\${active ? ' is-sorted' : ''}\`}",
  "className={\`\${col.className || ''}\${col.sortable ? ' is-sortable' : ''}\${active ? ' is-sorted' : ''}\${col.hideOnMobile ? ' hide-on-mobile' : ''}\`}"
);

// For td (skeleton)
code = code.replace(
  /<td key=\{c\.key\} className=\{c\.className\}>/g,
  `<td key={c.key} className={\`\${c.className || ''} \${c.hideOnMobile ? 'hide-on-mobile' : ''}\`}>`
);

// For td (actual)
code = code.replace(
  /<td key=\{col\.key\} className=\{col\.className\}>/g,
  `<td key={col.key} className={\`\${col.className || ''} \${col.hideOnMobile ? 'hide-on-mobile' : ''}\`}>`
);

fs.writeFileSync('src/components/lobby/LobbyTable.tsx', code);
