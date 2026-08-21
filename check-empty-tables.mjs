import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  for (const t of ['user_poker_stats', 'poker_session_stats', 'user_stats', 'hand_players']) {
    const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
    console.log(`${t}: ${error ? error.message : count + ' rows'}`);
  }
}
run();
