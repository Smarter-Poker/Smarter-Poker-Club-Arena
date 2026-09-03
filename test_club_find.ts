import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!);

async function run() {
  const { data: club, error } = await supabase
    .from('clubs')
    .select('id')
    .eq('club_id', 25450)
    .maybeSingle();
  console.log('Club 25450:', { club, error });
}
run();
