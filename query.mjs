import { createClient } from '@supabase/supabase-js';
const SUPABASE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function main() {
  const { data: moreProfiles, error: e2 } = await supabase
    .from('profiles')
    .select('*')
    .or('username.ilike.%Fourbet%,username.ilike.%Diamond Dan%,username.ilike.%Darktunnel%,username.ilike.%Kickertrouble%,username.ilike.%Inposition%');
    
  console.log('Profiles:', JSON.stringify(moreProfiles, null, 2));
}

main();
