/**
 * 🐴 Shark Club Horse Seed Script
 * Inserts 100 horse profiles (#101-#200) into the Shark Club stable.
 * 
 * Run with: node supabase/seed_horses.mjs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
});

// Profile distribution: Fish 40, Reg 30, Nit 15, Lag 10, Maniac 5
function getProfile(i) {
    if (i <= 140) return 'fish';
    if (i <= 170) return 'reg';
    if (i <= 185) return 'nit';
    if (i <= 195) return 'lag';
    return 'maniac';
}

function makeUUID(prefix, num) {
    return `${prefix}-${num.toString().padStart(12, '0')}`;
}

async function main() {
    console.log('🐴 Starting Shark Club Horse Seed...\n');

    // Step 1: Find the Shark Club UUID
    const { data: clubs, error: clubErr } = await supabase
        .from('clubs')
        .select('id, name, club_id')
        .eq('club_id', 25450)
        .limit(1);

    if (clubErr || !clubs?.length) {
        console.error('❌ Failed to find Shark Club (club_id=25450):', clubErr);
        process.exit(1);
    }

    const sharkClubUUID = clubs[0].id;
    console.log(`♠ Found Shark Club: ${clubs[0].name} (${sharkClubUUID})\n`);

    // Step 2: Create auth.users entries for horses
    let authCreated = 0;
    for (let i = 101; i <= 200; i++) {
        const horseId = makeUUID('22222222-2222-2222-2222', i);
        const { error } = await supabase.auth.admin.createUser({
            uid: horseId,
            email: `horse${i}@smarter.poker`,
            password: `horse_secure_${i}_!`,
            email_confirm: true,
            user_metadata: { is_horse: true, horse_number: i },
        });
        if (!error) {
            authCreated++;
        } else if (error.message?.includes('already been registered')) {
            // Already exists, skip
        } else {
            console.warn(`  ⚠ Auth user #${i}: ${error.message}`);
        }
    }
    console.log(`✅ Auth users created: ${authCreated} new (skipped existing)\n`);

    // Step 3: Upsert horse profiles
    const profiles = [];
    for (let i = 101; i <= 200; i++) {
        profiles.push({
            id: makeUUID('22222222-2222-2222-2222', i),
            username: `Horse_${i}`,
            display_name: `Horse #${i}`,
            avatar_url: null,
            player_number: 20000 + i,
            is_horse: true,
            horse_profile: getProfile(i),
            horse_status: 'available',
            xp: 0,
            level: 1,
            vip_level: 'bronze',
            streak_days: 0,
            last_login: new Date().toISOString(),
            stats: {},
            settings: {},
        });
    }

    const { error: profileErr } = await supabase
        .from('profiles')
        .upsert(profiles, { onConflict: 'id' });

    if (profileErr) {
        console.error('❌ Profile upsert failed:', profileErr);
        process.exit(1);
    }
    console.log(`✅ Upserted ${profiles.length} horse profiles\n`);

    // Step 4: Add horses as club members
    const members = [];
    for (let i = 101; i <= 200; i++) {
        members.push({
            id: makeUUID('33333333-3333-3333-3333', i),
            club_id: sharkClubUUID,
            user_id: makeUUID('22222222-2222-2222-2222', i),
            role: 'member',
            nickname: `Horse #${i}`,
            chip_balance: 100000.00,
            status: 'active',
            joined_at: new Date().toISOString(),
        });
    }

    const { error: memberErr } = await supabase
        .from('club_members')
        .upsert(members, { onConflict: 'id' });

    if (memberErr) {
        console.error('❌ Club member upsert failed:', memberErr);
        process.exit(1);
    }
    console.log(`✅ Registered ${members.length} horses in Shark Club\n`);

    // Step 5: Verify
    const { count } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('is_horse', true);

    console.log(`\n🏁 DONE! Total horse profiles in database: ${count}`);
    console.log('   Fish: 40 | Reg: 30 | Nit: 15 | Lag: 10 | Maniac: 5');
}

main().catch(console.error);
