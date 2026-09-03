import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!);

async function run() {
  const { data: club } = await supabase
    .from('clubs')
    .select('id')
    .eq('club_id', 25450)
    .maybeSingle();
  const cid = club!.id;

  const { count: c1 } = await supabase
    .from('club_members')
    .select('*', { count: 'exact', head: true })
    .eq('club_id', cid);
  console.log('Total in club_members:', c1);

  const { count: c2 } = await supabase
    .from('club_members')
    .select('user_id, profiles!inner(id)', { count: 'exact', head: true })
    .eq('club_id', cid);
  console.log('Total with profiles!inner:', c2);
}
run();
