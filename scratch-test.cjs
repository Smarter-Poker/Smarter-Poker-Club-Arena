const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://wshzzhizxojohqjmtlck.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function getTodayKey() { return new Date().toISOString().split('T')[0]; }
function getWeekKey() { 
  const d = new Date(); d.setUTCDate(d.getUTCDate() - d.getUTCDay() + (d.getUTCDay() === 0 ? -6 : 1)); 
  return d.toISOString().split('T')[0] + '_W'; 
}
function getMonthKey() { return new Date().toISOString().slice(0, 7); }

async function main() {
  const { data: users } = await supabase.from('profiles').select('id, email').eq('email', 'DANIEL@BEKAVACTRADING.COM');
  const userId = users[0].id;

  console.log("Calling bump_challenge_progress for", userId);
  const { data, error } = await supabase.rpc('bump_challenge_progress', {
    p_user_id: userId,
    p_amounts: { hands_played: 1 },
    p_daily_key: getTodayKey(),
    p_weekly_key: getWeekKey(),
    p_monthly_key: getMonthKey(),
  });

  if (error) {
    console.error("RPC Error:", error);
  } else {
    console.log("RPC Data:", data);
  }
}
main();
