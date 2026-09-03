import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!);

async function run() {
  const clubIdStr = '25450';
  const { data: clubData } = await supabase
    .from('clubs')
    .select('id')
    .eq('club_id', Number(clubIdStr))
    .maybeSingle();
  const resolvedId = clubData.id;

  // Test ClubDashboard query 1
  const { count: memberCount, error: err1 } = await supabase
    .from('club_members')
    .select('user_id, profiles!inner(id)', { count: 'exact', head: true })
    .eq('club_id', resolvedId)
    .eq('profiles.is_horse', false);

  console.log('ClubDashboard query 1:', { memberCount, err1: err1?.message });

  // Test ClubDashboard query 2
  const { data: playersData, error: err2 } = await supabase
    .from('club_members')
    .select(
      `
        user_id,
        chips_won,
        chips_lost,
        hands_played,
        profiles!inner(display_name, avatar_url, is_horse)
    `
    )
    .eq('club_id', resolvedId)
    .eq('profiles.is_horse', false)
    .order('chips_won', { ascending: false })
    .limit(5);

  console.log('ClubDashboard query 2:', { playersCount: playersData?.length, err2: err2?.message });
}
run();
