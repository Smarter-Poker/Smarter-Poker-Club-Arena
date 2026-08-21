const fs = require('fs');
const file = 'src/pages/DailyChallengesPage.tsx';
let code = fs.readFileSync(file, 'utf8');

const injectHookTarget = `  const [now, setNow] = useState(Date.now());
  const dateKeyRef = useRef(todayUtcKey());
  const isMountedRef = useIsMounted();`;

const injectHookReplacement = `  const [now, setNow] = useState(Date.now());
  const dateKeyRef = useRef(todayUtcKey());
  const isMountedRef = useIsMounted();
  
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
code = code.replace(injectHookTarget, injectHookReplacement);

fs.writeFileSync(file, code);
