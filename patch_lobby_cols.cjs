const fs = require('fs');
let code = fs.readFileSync('src/components/lobby/LobbyTable.tsx', 'utf8');

if (!code.includes("hideOnMobile?: boolean;")) {
  code = code.replace(
    "className?: string;",
    "className?: string;\n  hideOnMobile?: boolean;"
  );
}

// Now replace the switch statement for columnsFor
const newColumnsFor = `export function columnsFor(category: LobbyCategory): ColumnDef[] {
  switch (category) {
    case 'HOLDEM':
    case 'OMAHA':
    case 'LIMIT':
    case 'MIXED':
      return [
        COL_FAV,
        COL_NAME,
        COL_STAKES,
        { ...COL_VARIANT, hideOnMobile: true },
        COL_PLAYERS,
        { ...COL_BUYIN, hideOnMobile: true },
        { ...COL_RULES, hideOnMobile: true },
        { ...COL_STATUS, hideOnMobile: true },
      ];
    case 'MTT':
      return [
        COL_STARTS,
        { ...COL_VARIANT, label: 'Game Type', hideOnMobile: true },
        COL_BUYIN,
        COL_TNAME,
        COL_GTD,
        { ...COL_SPEED, hideOnMobile: true },
        { ...COL_PLAYERS, label: 'Enrolled' },
        COL_STATUS,
      ];
    case 'SPIN':
      return [COL_NAME, { ...COL_VARIANT, hideOnMobile: true }, COL_BUYIN, COL_PLAYERS, { ...COL_SPEED, hideOnMobile: true }, COL_STATUS];
    case 'SNG':
      return [COL_NAME, { ...COL_VARIANT, hideOnMobile: true }, COL_BUYIN, COL_PLAYERS, COL_STATUS];
    case 'ALL':
    default:
      return [
        COL_FAV,
        COL_NAME,
        { ...COL_KIND, hideOnMobile: true },
        COL_VARIANT,
        { ...COL_COST, hideOnMobile: true },
        COL_PLAYERS,
        COL_STARTS,
        COL_STATUS,
      ];
  }
}`;

code = code.replace(/export function columnsFor[\s\S]*?\}\n\}/, newColumnsFor);

// Now apply the class in the render
code = code.replace(
  /<th\s*key=\{col\.key\}/,
  `<th key={col.key} className={col.hideOnMobile ? 'hide-on-mobile' : ''}`
);
code = code.replace(
  /<td\s*key=\{col\.key\}\s*className=\{col\.className\}/,
  `<td key={col.key} className={\`\${col.className || ''} \${col.hideOnMobile ? 'hide-on-mobile' : ''}\`}`
);
// wait, the original th might already have a className. Let's just do a regex replace for the map functions.
