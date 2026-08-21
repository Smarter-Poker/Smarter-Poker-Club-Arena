const fs = require('fs');
const file = 'supabase/migrations/20260821_leaderboard_payouts_and_settings.sql';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  'FROM fn_club_leaderboard_period_v2(p_club_id, p_metric, p_start_date, p_end_date, 10, 0)',
  'FROM fn_club_leaderboard_by_dates(p_club_id, p_metric, p_start_date::date, p_end_date::date, 10, 0)'
);

fs.writeFileSync(file, code);
