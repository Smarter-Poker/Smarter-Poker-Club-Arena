require('dotenv').config({ path: '/Users/smarter.poker/Documents/Smarter-Poker-World-Hub/.env.local' });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/['"]+/g, '');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY.replace(/['"]+/g, '');

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
    const personas = JSON.parse(fs.readFileSync('/Users/smarter.poker/Documents/Smarter-Poker-World-Hub/src/content-engine/personas.json', 'utf8')).personas;
    
    const personaMap = {};
    personas.forEach((p, index) => {
        const playerNumber = 101 + index;
        const horseId = `horse-${String(playerNumber).padStart(3, '0')}`;
        personaMap[horseId] = { name: p.name, alias: p.alias };
    });

    const { data: profiles, error } = await supabase
        .from('user_profiles')
        .select('id, display_name, username')
        .like('id', 'horse-%');
        
    if (error) {
        console.error("Error fetching profiles", error);
        return;
    }
    
    console.log(`Found ${profiles.length} horses in DB.`);
    
    let aliasCount = 0;
    let nameCount = 0;
    
    for (const profile of profiles) {
        const pData = personaMap[profile.id];
        if (!pData) continue;
        
        // 10% chance for alias, 90% for real name
        const useAlias = Math.random() < 0.10;
        const newDisplayName = useAlias ? pData.alias : pData.name;
        
        if (useAlias) aliasCount++;
        else nameCount++;
        
        await supabase
            .from('user_profiles')
            .update({ display_name: newDisplayName })
            .eq('id', profile.id);
    }
    
    console.log(`Updated ${nameCount} to real names, ${aliasCount} to aliases.`);
}
run();
