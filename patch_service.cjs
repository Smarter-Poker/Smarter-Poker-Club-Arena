const fs = require('fs');
let code = fs.readFileSync('src/services/LeaderboardService.ts', 'utf8');

code = code.replace(
  `        const { data, error } = await supabase.rpc('fn_club_leaderboard_period_v2', {
          p_club_id: resolvedClubId,
          p_metric: metric,
          p_period: period,
          p_limit: limit,
          p_offset: offset,
        });`,
  `        let data, error;
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
        }`
);

code = code.replace(
  `      const { data, error } = await supabase.rpc('fn_global_leaderboard_period', {
        p_metric: metric,
        p_period: period,
        p_limit: limit,
        p_offset: offset,
      });`,
  `      let data, error;
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
      }`
);

code = code.replace(
  `        const { data, error } = await supabase.rpc('fn_user_rank_period', {
          p_user_id: userId,
          p_club_id: resolvedClubId,
          p_metric: metric,
          p_period: period,
        });`,
  `        // fn_user_rank_period doesn't take periodOffset natively.
        // We need to route it to the new dates function if historical.
        let data, error;
        // Wait, getUserRank doesn't receive periodOffset!!
        // Let's just patch the method signature first.
        // I will do that via manual sed or another script.`
);
fs.writeFileSync('src/services/LeaderboardService.ts', code);
