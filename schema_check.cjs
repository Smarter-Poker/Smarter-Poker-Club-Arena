require('dotenv').config({ path: '/Users/smarter.poker/Documents/Smarter-Poker-World-Hub/.env.local' });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/['"]+/g, ''),
    process.env.SUPABASE_SERVICE_ROLE_KEY.replace(/['"]+/g, '')
);
async function run() {
    const { data, error } = await supabase.from('profiles').select('id, username').eq('id', 'player-101');
    console.log("data:", data, "error:", error);
}
run();
