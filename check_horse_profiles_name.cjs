require('dotenv').config({ path: '/Users/smarter.poker/Documents/Smarter-Poker-World-Hub/.env.local' });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/['"]+/g, ''),
    process.env.SUPABASE_SERVICE_ROLE_KEY.replace(/['"]+/g, '')
);

async function run() {
    const personas = JSON.parse(fs.readFileSync('/Users/smarter.poker/Documents/Smarter-Poker-World-Hub/src/content-engine/personas.json', 'utf8')).personas;
    const names = personas.map(p => p.name);
    
    const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, display_name, username')
        .in('display_name', names);
        
    console.log(`Found ${profiles?.length || 0} horses in profiles table by name.`);
}
run();
