const fs = require('fs');
const file = '/tmp/CA/src/pages/DailyChallengesPage.tsx';
let content = fs.readFileSync(file, 'utf8');

const target = `  const handleClaimAll = useCallback(async () => {`;
const replace = `  const handleReroll = useCallback(async (challenge: TieredChallenge) => {
    if (!userId) return;
    if (stats && stats.totalDiamondsEarned < 1000) {
      toast.error('Not enough diamonds (1,000 required).');
      return;
    }
    
    // Optimistic UI for Reroll
    setStats(prev => prev ? { ...prev, totalDiamondsEarned: prev.totalDiamondsEarned - 1000 } : prev);
    
    const nextChallenge = await dailyChallengeService.rerollChallenge(userId, challenge.id, 1000);
    if (nextChallenge) {
      setChallenges(prev => prev.map(c => 
        c.id === challenge.id ? { ...c, challenge: nextChallenge } : c
      ));
      toast.success('Challenge Rerolled!');
    } else {
      // Revert if failed
      setStats(prev => prev ? { ...prev, totalDiamondsEarned: prev.totalDiamondsEarned + 1000 } : prev);
      toast.error('Failed to reroll challenge.');
    }
  }, [userId, stats, toast]);

  const handleClaimAll = useCallback(async () => {`;

content = content.replace(target, replace);

const mapTarget = `                <ChallengeCard
                  challenge={c}
                  tier={c.tier}
                  claiming={claimingIds.has(c.id)}
                  celebrating={celebratingIds.has(c.id)}
                  onClaim={handleClaim}
                />`;

const mapReplace = `                <ChallengeCard
                  challenge={c}
                  tier={c.tier}
                  claiming={claimingIds.has(c.id)}
                  celebrating={celebratingIds.has(c.id)}
                  onClaim={handleClaim}
                  onReroll={handleReroll}
                />`;

content = content.replace(mapTarget, mapReplace);

// Also insert the leaderboard under the streakBanner
const leaderboardTarget = `        <div className={styles.streakRight}>
          <button
            className={styles.freezeButton}
            onClick={async () => {`;
            
const leaderboardReplace = `        <div className={styles.streakRight}>
          <button
            className={styles.freezeButton}
            onClick={async () => {`;

const fullLeaderboardTarget = `        <div className={styles.streakRight}>
          <button
            className={styles.freezeButton}
            onClick={async () => {
              if (stats && stats.totalDiamondsEarned >= 5000) {
                const ok = await dailyChallengeService.buyStreakFreeze(userId!);
                if (ok) {
                  setStats(prev => prev ? { ...prev, totalDiamondsEarned: prev.totalDiamondsEarned - 5000 } : prev);
                  toast.success('Streak Freeze Purchased!');
                } else {
                  toast.error('Failed to buy Streak Freeze.');
                }
              } else {
                toast.error('Not enough diamonds (5,000 required).');
              }
            }}
          >
            Buy ❄️ (5K 💎)
          </button>
        </div>
      </section>`;
      
const fullLeaderboardReplace = `        <div className={styles.streakRight}>
          <button
            className={styles.freezeButton}
            onClick={async () => {
              if (stats && stats.totalDiamondsEarned >= 5000) {
                const ok = await dailyChallengeService.buyStreakFreeze(userId!);
                if (ok) {
                  setStats(prev => prev ? { ...prev, totalDiamondsEarned: prev.totalDiamondsEarned - 5000 } : prev);
                  toast.success('Streak Freeze Purchased!');
                } else {
                  toast.error('Failed to buy Streak Freeze.');
                }
              } else {
                toast.error('Not enough diamonds (5,000 required).');
              }
            }}
          >
            Buy ❄️ (5K 💎)
          </button>
        </div>
      </section>
      
      <TopStreaksLeaderboard />`;

content = content.replace(fullLeaderboardTarget, fullLeaderboardReplace);

fs.writeFileSync(file, content, 'utf8');
