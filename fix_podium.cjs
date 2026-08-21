const fs = require('fs');
let code = fs.readFileSync('/Users/smarter.poker/Documents/club-arena/src/pages/LeaderboardPage.tsx', 'utf8');
code = code.replace(
  `              <motion.div className="podium-section" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: "easeOut" }}>
                {renderPodiumPlace(top3[1], 2)}
                {renderPodiumPlace(top3[0], 1)}
                {renderPodiumPlace(top3[2], 3)}
              </div>`,
  `              <motion.div className="podium-section" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: "easeOut" }}>
                {renderPodiumPlace(top3[1], 2)}
                {renderPodiumPlace(top3[0], 1)}
                {renderPodiumPlace(top3[2], 3)}
              </motion.div>`
);
fs.writeFileSync('/Users/smarter.poker/Documents/club-arena/src/pages/LeaderboardPage.tsx', code);
