const fs = require('fs');
let code = fs.readFileSync('src/pages/CashierTradePage.tsx', 'utf8');

const anchor = '<button\n              className={styles.classicLink}\n              onClick={() => navigate(`/clubs/${clubParam}/cashier-classic`)}';

const insertion = `{!loading && !loadError && visibleCount < list.length && (
            <button className={styles.classicLink} style={{marginBottom: '1rem'}} onClick={() => setVisibleCount(c => c + 25)}>
              Load More ({list.length - visibleCount} hidden)
            </button>
          )}\n          ` + anchor;

if (code.includes(anchor)) {
    code = code.replace(anchor, insertion);
    fs.writeFileSync('src/pages/CashierTradePage.tsx', code);
    console.log("Success");
} else {
    console.log("Anchor not found");
}
