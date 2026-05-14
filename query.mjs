import { createClient } from '@supabase/supabase-js';
const SUPABASE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1a2xmbmFwYmttYWN2d3hrdGJoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzczMDg0NCwiZXhwIjoyMDgzMzA2ODQ0fQ.bbDqj-me78PID99npWCZ5qUuINSC1-eCBb1BVhgiSRs';
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function main() {
  const { data: moreProfiles, error: e2 } = await supabase
    .from('profiles')
    .select('*')
    .or('username.ilike.%Fourbet%,username.ilike.%Diamond Dan%,username.ilike.%Darktunnel%,username.ilike.%Kickertrouble%,username.ilike.%Inposition%');
    
  console.log('Profiles:', JSON.stringify(moreProfiles, null, 2));
}

main();
