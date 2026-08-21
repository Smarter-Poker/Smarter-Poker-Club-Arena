import re

with open('src/services/LeaderboardService.ts', 'r') as f:
    code = f.read()

# Remove updateHandStats
code = re.sub(
    r'/\*\*\n   \* Update player stats after a completed hand.*?\n  async getUserRank\(',
    '/**\n   * Get user\'s rank on a specific club leaderboard.\n   */\n  async getUserRank(',
    code,
    flags=re.DOTALL
)

# Replace fn_club_leaderboard_period_v2 with dates logic
code = code.replace("""        const { data, error } = await supabase.rpc('fn_club_leaderboard_period_v2', {
          p_club_id: resolvedClubId,
          p_metric: metric,
          p_period: period,
          p_limit: limit,
          p_offset: offset,
        });""", """        let data, error;
        if (periodOffset < 0) {
          const { start, end } = this.getPeriodBoundaries(period, periodOffset);
          const result = await supabase.rpc('fn_club_leaderboard_by_dates', {
            p_club_id: resolvedClubId,
            p_metric: metric,
            p_start_date: start.toISOString().split('T')[0],
            p_end_date: end.toISOString().split('T')[0],
            p_limit: limit,
            p_offset: offset,
          });
          data = result.data; error = result.error;
        } else {
          const result = await supabase.rpc('fn_club_leaderboard_period_v2', {
            p_club_id: resolvedClubId,
            p_metric: metric,
            p_period: period,
            p_limit: limit,
            p_offset: offset,
          });
          data = result.data; error = result.error;
        }""")

# Replace fn_global_leaderboard_period
code = code.replace("""      const { data, error } = await supabase.rpc('fn_global_leaderboard_period', {
        p_metric: metric,
        p_period: period,
        p_limit: limit,
        p_offset: offset,
      });""", """      let data, error;
      if (periodOffset < 0) {
        const { start, end } = this.getPeriodBoundaries(period, periodOffset);
        const result = await supabase.rpc('fn_global_leaderboard_by_dates', {
          p_metric: metric,
          p_start_date: start.toISOString().split('T')[0],
          p_end_date: end.toISOString().split('T')[0],
          p_limit: limit,
          p_offset: offset,
        });
        data = result.data; error = result.error;
      } else {
        const result = await supabase.rpc('fn_global_leaderboard_period', {
          p_metric: metric,
          p_period: period,
          p_limit: limit,
          p_offset: offset,
        });
        data = result.data; error = result.error;
      }""")

# Replace getUserRank signature and body
old_getuserrank = """  async getUserRank(
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
        const { data, error } = await supabase.rpc('fn_user_rank_period', {
          p_user_id: userId,
          p_club_id: resolvedClubId,
          p_metric: metric,
          p_period: period,
        });"""
        
new_getuserrank = """  async getUserRank(
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
        }"""
code = code.replace(old_getuserrank, new_getuserrank)

# Replace getGlobalUserRank
old_getglobaluserrank = """  async getGlobalUserRank(
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
      });"""
      
new_getglobaluserrank = """  async getGlobalUserRank(
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
      }"""
code = code.replace(old_getglobaluserrank, new_getglobaluserrank)

with open('src/services/LeaderboardService.ts', 'w') as f:
    f.write(code)
