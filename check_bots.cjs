require('dotenv').config({ path: '/Users/smarter.poker/Documents/Smarter-Poker-World-Hub/.env.local' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/['"]+/g, ''),
    process.env.SUPABASE_SERVICE_ROLE_KEY.replace(/['"]+/g, '')
);
async function run() {
    const { data } = await supabase.from('bot_profiles').select('id, username').limit(5);
    console.log("bot_profiles:", data);
}
run();
