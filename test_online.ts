import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!);
async function run() {
  const { data, error } = await supabase
    .from('club_members')
    .select('*')
    .eq('is_online', true)
    .limit(1);
  console.log({ data, err: error?.message });
}
run();
