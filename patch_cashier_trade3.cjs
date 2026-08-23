const fs = require('fs');
let code = fs.readFileSync('src/pages/CashierTradePage.tsx', 'utf8');

const anchor = '                  </button>\n                </div>\n              </div>\n            </div>\n          ))}';
const insertion = '                  </button>\n                </div>\n              </div>\n            </div>\n          ))}\n          {!loading && !loadError && visibleCount < list.length && (\n            <button className={styles.classicLink} style={{marginTop: "1rem", marginBottom: "2rem"}} onClick={() => setVisibleCount(c => c + 25)}>Load More ({list.length - visibleCount} hidden)</button>\n          )}';

if (code.includes(anchor)) {
    code = code.replace(anchor, insertion);
    fs.writeFileSync('src/pages/CashierTradePage.tsx', code);
    console.log("Success");
} else {
    console.log("Anchor not found");
}
