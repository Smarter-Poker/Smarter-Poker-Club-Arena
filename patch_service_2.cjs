const fs = require('fs');
let code = fs.readFileSync('src/services/LeaderboardService.ts', 'utf8');

const targetStart = "  /**\n   * Update player stats after a completed hand.";
const targetEnd = "  /**\n   * Get user's rank on a specific club leaderboard.";
const startIdx = code.indexOf(targetStart);
const endIdx = code.indexOf(targetEnd);

if (startIdx > -1 && endIdx > startIdx) {
  code = code.substring(0, startIdx) + code.substring(endIdx);
}

// Fix getUserRank signature and implementation
code = code.replace(
  `  async getUserRank(
    userId: string,
    clubId: string,
    metric: LeaderboardMetric = 'profit',
    period: LeaderboardPeriod = 'weekly'
  ): Promise<{ rank: number; total: number; value: number } | null> {
    try {
      const resolvedClubId = await resolveClubUUID(clubId);
      const isRatio = metric === 'vpip' || metric === 'pfr';

      if (!isRatio) {
        // fn_user_rank_period handles every period including all_time.
        // fn_user_rank_period doesn't take periodOffset natively.
        // We need to route it to the new dates function if historical.
        let data, error;`,
  `  async getUserRank(
    userId: string,
    clubId: string,
    metric: LeaderboardMetric = 'profit',
    period: LeaderboardPeriod = 'weekly',
    periodOffset: number = 0
  ): Promise<{ rank: number; total: number; value: number } | null> {
    try {
      const resolvedClubId = await resolveClubUUID(clubId);
      const isRatio = metric === 'vpip' || metric === 'pfr';

      if (!isRatio) {
        let data, error;
        if (periodOffset < 0) {
          const { start, end } = this.getPeriodBoundaries(period, periodOffset);
          const result = await supabase.rpc('fn_user_rank_by_dates', {
            p_user_id: userId,
            p_club_id: resolvedClubId,
            p_metric: metric,
            p_start_date: start.toISOString().split('T')[0],
            p_end_date: end.toISOString().split('T')[0],
          });
          data = result.data; error = result.error;
        } else {
          const result = await supabase.rpc('fn_user_rank_period', {
            p_user_id: userId,
            p_club_id: resolvedClubId,
            p_metric: metric,
            p_period: period,
          });
          data = result.data; error = result.error;
        }`
);

// Fix getGlobalUserRank
code = code.replace(
  `  async getGlobalUserRank(
    userId: string,
    metric: LeaderboardMetric = 'profit',
    period: LeaderboardPeriod = 'weekly'
  ): Promise<{ rank: number; total: number; value: number } | null> {
    try {
      if (metric === 'vpip' || metric === 'pfr') return null;
      const { data, error } = await supabase.rpc('fn_user_rank_global_period', {
        p_user_id: userId,
        p_metric: metric,
        p_period: period,
      });`,
  `  async getGlobalUserRank(
    userId: string,
    metric: LeaderboardMetric = 'profit',
    period: LeaderboardPeriod = 'weekly',
    periodOffset: number = 0
  ): Promise<{ rank: number; total: number; value: number } | null> {
    try {
      if (metric === 'vpip' || metric === 'pfr') return null;
      let data, error;
      if (periodOffset < 0) {
        const { start, end } = this.getPeriodBoundaries(period, periodOffset);
        const result = await supabase.rpc('fn_user_rank_global_by_dates', {
          p_user_id: userId,
          p_metric: metric,
          p_start_date: start.toISOString().split('T')[0],
          p_end_date: end.toISOString().split('T')[0],
        });
        data = result.data; error = result.error;
      } else {
        const result = await supabase.rpc('fn_user_rank_global_period', {
          p_user_id: userId,
          p_metric: metric,
          p_period: period,
        });
        data = result.data; error = result.error;
      }`
);

fs.writeFileSync('src/services/LeaderboardService.ts', code);
