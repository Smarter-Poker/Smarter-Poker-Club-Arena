const fs = require('fs');
const file = '/tmp/CA/src/services/DailyChallengeService.ts';
let content = fs.readFileSync(file, 'utf8');

const target = `  async buyStreakFreeze(userId: string): Promise<boolean> {`;
const replace = `  async rerollChallenge(userId: string, challengeId: string, cost: number): Promise<DailyChallenge | null> {
    try {
      // MOCK RPC CALL
      // const { data, error } = await supabase.rpc('reroll_daily_challenge', {
      //   p_user_id: userId,
      //   p_old_challenge_id: challengeId,
      //   p_cost: cost
      // });
      // if (error) throw error;
      
      // Simulate backend picking a new random challenge from the Daily pool
      const pool = CHALLENGE_POOL; // Assuming daily tier for now
      const current = pool.find(c => c.id === challengeId);
      if (!current) return null;
      
      // Pick a random challenge of the same tier that isn't the current one
      const available = pool.filter(c => c.id !== challengeId);
      const next = available[Math.floor(Math.random() * available.length)];
      return next;
    } catch (e) {
      console.error('Failed to reroll:', e);
      return null;
    }
  }

  async buyStreakFreeze(userId: string): Promise<boolean> {`;

content = content.replace(target, replace);
fs.writeFileSync(file, content, 'utf8');
