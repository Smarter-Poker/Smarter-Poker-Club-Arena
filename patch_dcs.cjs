const fs = require('fs');
const file = 'src/services/DailyChallengeService.ts';
let code = fs.readFileSync(file, 'utf8');

const target = `  async buyStreakFreeze(userId: string): Promise<boolean> {
    try {
      const { data, error } = await supabase.rpc('buy_streak_freeze', {
        p_user_id: userId,
      });
      if (error) {
        if (error.message.includes('Could not find the function')) {
          // Graceful mock if RPC is not deployed yet
          return true;
        }
        console.error('Failed to buy streak freeze:', error);
        return false;
      }
      return data;
    } catch (e) {
      return true; // Mock success
    }
  }`;

const replacement = `  async buyStreakFreeze(): Promise<boolean> {
    try {
      const { data, error } = await supabase.rpc('fn_buy_streak_freeze');
      if (error) throw error;
      const res = data as any;
      if (!res.success) throw new Error(res.error || 'Failed to buy freeze');
      return true;
    } catch (e: any) {
      throw new Error(e.message || 'Error buying freeze');
    }
  }`;

code = code.replace(target, replacement);
fs.writeFileSync(file, code);
