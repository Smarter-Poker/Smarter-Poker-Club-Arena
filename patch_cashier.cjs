const fs = require('fs');

let content = fs.readFileSync('src/pages/CashierTradePage.tsx', 'utf8');

// The player row click logic
const targetRow = `                <div
                  key={r.userId}
                  className={\`\${styles.row} \${selected.has(r.userId) ? styles.rowSelected : ''}\`}
                  onClick={() => toggleSelection(r.userId)}
                >`;

const replacementRow = `                <div
                  key={r.userId}
                  className={\`\${styles.row} \${selected.has(r.userId) ? styles.rowSelected : ''}\`}
                >
                  <div 
                    className={styles.rowInfoWrapper}
                    onClick={() => navigate(\`/clubs/\${clubParam}/members/\${r.userId}\`)}
                  >`;

content = content.replace(targetRow, replacementRow);

const targetInfoEnd = `                  </div>
                  <span className={styles.rowBalance}>{fmt(r.chipBalance)}</span>`;

const replacementInfoEnd = `                  </div>
                  </div>
                  <div className={styles.rowActionWrapper} onClick={() => toggleSelection(r.userId)}>
                  <span className={styles.rowBalance}>{fmt(r.chipBalance)}</span>`;

content = content.replace(targetInfoEnd, replacementInfoEnd);

const targetDivEnd = `                    aria-hidden="true"
                  />
                </div>`;

const replacementDivEnd = `                    aria-hidden="true"
                  />
                  </div>
                </div>`;

content = content.replace(targetDivEnd, replacementDivEnd);

fs.writeFileSync('src/pages/CashierTradePage.tsx', content, 'utf8');
