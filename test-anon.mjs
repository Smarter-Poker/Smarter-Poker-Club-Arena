import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabaseUrl = process.env.VITE_SUPABASE_URL
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY
const supabase = createClient(supabaseUrl, supabaseAnonKey)

async function run() {
  console.log("Fetching as anon...");
  const { data, error } = await supabase.rpc('ca_club_members_overview', {
    p_club_id: 'a0000000-0000-0000-0000-000000000001'
  });
  console.log("Error:", error);
  console.log("Data count:", data?.length);
  if (data?.length > 0) console.log(data[0]);
}
run();
