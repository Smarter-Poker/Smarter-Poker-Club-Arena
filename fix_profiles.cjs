require('dotenv').config({ path: '/Users/smarter.poker/Documents/Smarter-Poker-World-Hub/.env.local' });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/['"]+/g, ''),
    process.env.SUPABASE_SERVICE_ROLE_KEY.replace(/['"]+/g, '')
);

async function run() {
    const personas = JSON.parse(fs.readFileSync('/Users/smarter.poker/Documents/Smarter-Poker-World-Hub/src/content-engine/personas.json', 'utf8')).personas;
    const personaMap = {};
    personas.forEach(p => {
        personaMap[p.name.toLowerCase()] = p;
        personaMap[p.alias.toLowerCase()] = p;
        const noSpaceAlias = p.alias.replace(/\s+/g, '').toLowerCase();
        personaMap[noSpaceAlias] = p;
    });

    const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, display_name, username');
        
    let matchCount = 0;
    let aliasCount = 0;
    let nameCount = 0;
    
    for (const profile of profiles) {
        const u = profile.username ? profile.username.toLowerCase() : '';
        const d = profile.display_name ? profile.display_name.toLowerCase() : '';
        
        const pData = personaMap[u] || personaMap[d];
        if (!pData) continue;
        
        matchCount++;
        const useAlias = Math.random() < 0.10;
        const newDisplayName = useAlias ? pData.alias : pData.name;
        
        if (useAlias) aliasCount++;
        else nameCount++;
        
        await supabase
            .from('profiles')
            .update({ display_name: newDisplayName })
            .eq('id', profile.id);
    }
    console.log(`Matched ${matchCount} horses in profiles. Updated ${nameCount} to names, ${aliasCount} to aliases.`);
}
run();
