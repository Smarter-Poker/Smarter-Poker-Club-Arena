const fs = require('fs');
const file = 'src/components/table/SessionSummary.tsx';
let content = fs.readFileSync(file, 'utf8');

// Replace {totalRebuys > 0 && (... Rebuys ...)} with Total Buy-ins
content = content.replace(
  /\{totalRebuys > 0 && \(\n\s*<div className=\{styles\.statItem\}>\n\s*<span className=\{styles\.statValue\}>\{totalRebuys\}<\/span>\n\s*<span className=\{styles\.statLabel\}>Rebuys<\/span>\n\s*<\/div>\n\s*\)\}/g,
  `<div className={styles.statItem}>
              <span className={styles.statValue}>{1 + totalRebuys}</span>
              <span className={styles.statLabel}>Total Buy-ins</span>
            </div>`
);

fs.writeFileSync(file, content);
