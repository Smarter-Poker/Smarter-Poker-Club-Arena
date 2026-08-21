require('dotenv').config({ path: '/Users/smarter.poker/Documents/Smarter-Poker-World-Hub/.env.local' });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/['"]+/g, ''),
    process.env.SUPABASE_SERVICE_ROLE_KEY.replace(/['"]+/g, '')
);

async function run() {
    const personas = JSON.parse(fs.readFileSync('/Users/smarter.poker/Documents/Smarter-Poker-World-Hub/src/content-engine/personas.json', 'utf8')).personas;
    const aliases = personas.map(p => p.alias);
    
    const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, display_name, username')
        .in('username', aliases);
        
    console.log(`Found ${profiles?.length || 0} horses in profiles table by username.`);
    if (profiles && profiles.length > 0) {
        console.log("Sample:", profiles[0]);
    }
}
run();
