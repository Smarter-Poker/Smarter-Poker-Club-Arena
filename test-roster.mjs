import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

const supabaseUrl = process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

async function run() {
  const start = Date.now();
  const { data, error } = await supabase.rpc('ca_club_members_overview', {
    p_club_id: 'a0000000-0000-0000-0000-000000000001'
  });
  console.log("Time taken:", Date.now() - start, "ms");
  console.log("Error:", error);
  console.log("Data length:", data?.length);
}
run();
