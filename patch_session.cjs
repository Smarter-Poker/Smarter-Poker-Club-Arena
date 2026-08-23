const fs = require('fs');
const file = 'src/components/session/SessionSummaryHost.tsx';
let content = fs.readFileSync(file, 'utf8');

// Replace "Rebuys" logic with "Total Buy-ins"
content = content.replace(
  /if \(payload\.totalRebuys > 0\) \{\n\s*out\.push\(\{ label: 'Rebuys', value: String\(payload\.totalRebuys\) \}\);\n\s*\}/g,
  `out.push({ label: 'Total Buy-ins', value: String(1 + payload.totalRebuys) });`
);

fs.writeFileSync(file, content);
