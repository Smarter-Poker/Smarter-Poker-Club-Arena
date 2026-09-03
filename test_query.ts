import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!);

async function run() {
  const clubIdStr = '25450';
  console.log('Resolving internal id for club_id=', clubIdStr);
  const { data: clubData } = await supabase
    .from('clubs')
    .select('id')
    .eq('club_id', Number(clubIdStr))
    .maybeSingle();
  if (!clubData) return console.log('Club not found');
  const resolvedId = clubData.id;
  console.log('resolvedId =', resolvedId);

  const unionClubIds = [resolvedId];
  console.log('Querying club_members with in(', unionClubIds, ')');

  const { count, error } = await supabase
    .from('club_members')
    .select('*', { count: 'exact', head: true })
    .in('club_id', unionClubIds)
    .in('status', ['active', 'approved']);

  console.log('Result:', { count, error });

  const { data: profilesErr } = await supabase
    .from('profiles')
    .select('*')
    .in('club_id', unionClubIds)
    .limit(1);
  console.log('Profiles check err:', profilesErr);
}
run();
