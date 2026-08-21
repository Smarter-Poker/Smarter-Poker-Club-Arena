require('dotenv').config({ path: '/Users/smarter.poker/Documents/Smarter-Poker-World-Hub/.env.local' });
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/['"]+/g, '');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY.replace(/['"]+/g, '');
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
    const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, display_name, username')
        .limit(10);
    console.log(profiles);
}
run();
