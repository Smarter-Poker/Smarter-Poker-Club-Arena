const fs = require('fs');
let code = fs.readFileSync('src/pages/CashierTradePage.tsx', 'utf8');

code = code.replace(
  '            </div>\n          ))}\n        </div>',
  '            </div>\n          ))}\n          {!loading && !loadError && visibleCount < list.length && (\n            <button className={styles.classicLink} style={{marginTop: "1rem"}} onClick={() => setVisibleCount(c => c + 25)}>Load More</button>\n          )}\n        </div>'
);

fs.writeFileSync('src/pages/CashierTradePage.tsx', code);
