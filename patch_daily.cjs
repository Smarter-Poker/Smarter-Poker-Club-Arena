const fs = require('fs');
const file = 'src/pages/DailyChallengesPage.tsx';
let code = fs.readFileSync(file, 'utf8');

// 1. Add handleBuyFreeze
const loadHooksTarget = `  // ── Reload loop ──`;
const loadHooksReplacement = `  const [buyingFreeze, setBuyingFreeze] = useState(false);

  const handleBuyFreeze = async () => {
    if (!userId) return;
    setBuyingFreeze(true);
    try {
      await dailyChallengeService.buyStreakFreeze();
      toast?.success?.('Streak frozen for today!');
      // Refresh local challenges
      loadChallenges(userId, true);
    } catch (e: any) {
      toast?.error?.(e.message || 'Failed to buy streak freeze');
    } finally {
      setBuyingFreeze(false);
    }
  };

  // ── Reload loop ──`;
code = code.replace(loadHooksTarget, loadHooksReplacement);

// 2. Add Confetti tracking for live updates
const loadHookTarget = `      if (isMountedRef.current) {
        setChallenges(ch);
        setStreak(st);
        setStats(ds);
      }`;
const loadHookReplacement = `      if (isMountedRef.current) {
        // Confetti for live-completed challenges that weren't completed before
        setChallenges(prev => {
          if (prev.length > 0 && !silent) {
            const newlyCompleted = ch.filter(nc => nc.completed && !prev.find(pc => pc.id === nc.id)?.completed);
            if (newlyCompleted.length > 0) {
               // Not using the full reward overlay, just trigger a quick confetti from masterBus or local state?
               // Since we have setReward which does Confetti, let's just use that!
               setReward({
                 name: newlyCompleted[0].challenge.title + ' Completed!',
                 diamonds: newlyCompleted[0].challenge.diamondReward || 0,
                 chips: newlyCompleted[0].challenge.chipReward || 0
               });
            }
          }
          return ch;
        });
        setStreak(st);
        setStats(ds);
      }`;
code = code.replace(loadHookTarget, loadHookReplacement);

// 3. Inject Buy Freeze Button
const freezeUITarget = `            <span className={styles.freezeLine}>
              {streak.freezesAvailable > 0
                ? \`\${streak.freezesAvailable} streak freeze\${streak.freezesAvailable === 1 ? '' : 's'} banked\`
                : 'No streak freeze banked'}
              {streak.nextFreezeIn != null
                ? \` - next in \${streak.nextFreezeIn} day\${streak.nextFreezeIn === 1 ? '' : 's'}\`
                : ''}
            </span>
          )}
        </div>`;
const freezeUIReplacement = `            <span className={styles.freezeLine}>
              {streak.freezesAvailable > 0
                ? \`\${streak.freezesAvailable} streak freeze\${streak.freezesAvailable === 1 ? '' : 's'} banked\`
                : 'No streak freeze banked'}
              {streak.nextFreezeIn != null
                ? \` - next in \${streak.nextFreezeIn} day\${streak.nextFreezeIn === 1 ? '' : 's'}\`
                : ''}
            </span>
          )}
          {!streak?.usedFreeze && (
            <button 
              className="btn-secondary" 
              style={{ marginLeft: '10px', fontSize: '12px', padding: '4px 10px' }}
              onClick={handleBuyFreeze}
              disabled={buyingFreeze}
            >
              {buyingFreeze ? 'Working...' : 'Buy Freeze (5k 💎)'}
            </button>
          )}
        </div>`;
code = code.replace(freezeUITarget, freezeUIReplacement);

fs.writeFileSync(file, code);
