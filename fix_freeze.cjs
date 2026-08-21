const fs = require('fs');
let code = fs.readFileSync('/Users/smarter.poker/Documents/club-arena/src/pages/DailyChallengesPage.tsx', 'utf8');

if (!code.includes('const [buyingFreeze, setBuyingFreeze]')) {
  code = code.replace(
    /const \[rerollingId, setRerollingId\] = useState<string \| null>\(null\);/,
    `const [rerollingId, setRerollingId] = useState<string | null>(null);\n  const [buyingFreeze, setBuyingFreeze] = useState(false);`
  );
  
  const handleBuyFreezeImpl = `
  const handleBuyFreeze = async () => {
    try {
      setBuyingFreeze(true);
      await DailyChallengeService.buyStreakFreeze();
      toast.success('Freeze purchased! Your streak is safe for 1 missed day.');
      loadStreak();
    } catch (err: any) {
      toast.error(err.message || 'Failed to buy freeze');
    } finally {
      setBuyingFreeze(false);
    }
  };
`;
  
  code = code.replace(
    /const handleReroll = async \(challengeId: string\) => {/,
    handleBuyFreezeImpl + '\n  const handleReroll = async (challengeId: string) => {'
  );
  
  fs.writeFileSync('/Users/smarter.poker/Documents/club-arena/src/pages/DailyChallengesPage.tsx', code);
}
