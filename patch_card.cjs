const fs = require('fs');
const file = '/tmp/CA/src/pages/DailyChallengesPage.tsx';
let content = fs.readFileSync(file, 'utf8');

const propsTarget = `  celebrating: boolean;
  onClaim: (c: TieredChallenge) => void;
}) {`;
const propsReplace = `  celebrating: boolean;
  onClaim: (c: TieredChallenge) => void;
  onReroll?: (c: TieredChallenge) => void;
}) {`;
content = content.replace(propsTarget, propsReplace);

const buttonTarget = `            </span>
            <span className={styles.rewardLabel}>Chips</span>
          </div>
        )}
      </div>

      <div className={styles.cardRight}>`;

const buttonReplace = `            </span>
            <span className={styles.rewardLabel}>Chips</span>
          </div>
        )}
      </div>

      <div className={styles.cardRight}>
        {!done && onReroll && (
          <button
            className={styles.rerollBtn}
            onClick={(e) => {
              e.stopPropagation();
              onReroll(challenge);
            }}
            disabled={claiming}
          >
            🎲 Reroll
          </button>
        )}`;
content = content.replace(buttonTarget, buttonReplace);

// Also add TopStreaksLeaderboard import
const importTarget = `import { ConfettiEffect } from '../components/effects/ConfettiEffect';`;
const importReplace = `import { ConfettiEffect } from '../components/effects/ConfettiEffect';\nimport { TopStreaksLeaderboard } from '../components/gamification/TopStreaksLeaderboard';`;
content = content.replace(importTarget, importReplace);

fs.writeFileSync(file, content, 'utf8');
