const fs = require('fs');
const file = 'src/pages/DailyChallengesPage.tsx';
let code = fs.readFileSync(file, 'utf8');

const target = `  const [userId, setUserId] = useState<string | null>(null);`;
const replacement = `  const [userId, setUserId] = useState<string | null>(null);
  
  const [buyingFreeze, setBuyingFreeze] = useState(false);

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
  };`;

code = code.replace(target, replacement);
fs.writeFileSync(file, code);
