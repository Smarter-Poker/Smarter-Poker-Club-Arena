const fs = require('fs');
let content = fs.readFileSync('src/pages/CashierTradePage.tsx', 'utf8');

const targetStr = `                <div
                  key={r.userId}
                  className={\`\${styles.row} \${selected.has(r.userId) ? styles.rowSelected : ''}\`}
                  onClick={() => toggleSelection(r.userId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleSelection(r.userId);
                    }
                  }}
                  role="checkbox"
                  aria-checked={selected.has(r.userId)}
                  tabIndex={0}
                >
                  {r.avatarUrl ? (
                    <img src={r.avatarUrl} alt="" className={styles.avatar} />
                  ) : (
                    <span className={styles.avatarFallback}>{initial(r.name)}</span>
                  )}
                  <div className={styles.rowInfo}>
                    <span className={styles.rowName}>{r.name}</span>
                    <span className={styles.rowSub}>
                      {r.playerNumber ? \`ID: \${r.playerNumber} · \` : ''}
                      <span style={{ textTransform: 'capitalize' }}>
                        {r.role.replace('_', ' ')}
                        {r.isHorse ? ' (horse)' : ''}
                      </span>
                      {r.username ? \` · @\${r.username}\` : ''}
                    </span>
                  </div>
                  <span className={styles.rowBalance}>{fmt(r.chipBalance)}</span>
                  <span
                    className={\`\${styles.checkbox} \${selected.has(r.userId) ? styles.checkboxOn : ''}\`}
                    aria-hidden="true"
                  />
                </div>`;

const replaceStr = `                <div
                  key={r.userId}
                  className={\`\${styles.row} \${selected.has(r.userId) ? styles.rowSelected : ''}\`}
                >
                  <div
                    className={styles.rowInfoWrapper}
                    onClick={() => navigate(\`/clubs/\${clubParam}/members/\${r.userId}\`)}
                  >
                    {r.avatarUrl ? (
                      <img src={r.avatarUrl} alt="" className={styles.avatar} />
                    ) : (
                      <span className={styles.avatarFallback}>{initial(r.name)}</span>
                    )}
                    <div className={styles.rowInfo}>
                      <span className={styles.rowName}>{r.name}</span>
                      <span className={styles.rowSub}>
                        {r.playerNumber ? \`ID: \${r.playerNumber} · \` : ''}
                        <span style={{ textTransform: 'capitalize' }}>
                          {r.role.replace('_', ' ')}
                          {r.isHorse ? ' (horse)' : ''}
                        </span>
                        {r.username ? \` · @\${r.username}\` : ''}
                      </span>
                    </div>
                  </div>
                  <div
                    className={styles.rowActionWrapper}
                    onClick={() => toggleSelection(r.userId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleSelection(r.userId);
                      }
                    }}
                    role="checkbox"
                    aria-checked={selected.has(r.userId)}
                    tabIndex={0}
                  >
                    <span className={styles.rowBalance}>{fmt(r.chipBalance)}</span>
                    <span
                      className={\`\${styles.checkbox} \${selected.has(r.userId) ? styles.checkboxOn : ''}\`}
                      aria-hidden="true"
                    />
                  </div>
                </div>`;

content = content.replace(targetStr, replaceStr);
fs.writeFileSync('src/pages/CashierTradePage.tsx', content, 'utf8');
