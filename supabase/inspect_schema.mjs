/**
 * Schema Inspector v2 — Get column names for empty tables via insert error messages
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    'https://kuklfnapbkmacvwxktbh.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: { persistSession: false },
        global: {
            headers: {
                'x-smarter-data-actor': 'service',
                'x-smarter-data-protocol': '1'
            }
        }
    }
);

// Tables that returned empty or had errors — need column discovery
const EMPTY_TABLES = [
    'agents', 'tournaments', 'club_announcements', 'promotions',
    'friend_requests', 'chip_transactions', 'hands', 'spin_tournaments',
    // agent_commissions replaced commission_records (dropped by phase 7, 2026-09-01).
    'horses', 'daily_spins', 'agent_commissions', 'player_stats',
    'user_achievements', 'achievements', 'promotion_enrollments',
    'promotion_leaderboards', 'settlement_periods', 'agent_settlements',
    'club_settlements', 'player_weekly_snapshots', 'bbj_pools',
    'rake_records', 'club_transactions', 'vip_feature_usage',
    'union_clubs', 'messages'
];

async function inspectEmpty() {
    for (const table of EMPTY_TABLES) {
        // Use REST API metadata endpoint
        try {
            const resp = await fetch(`https://kuklfnapbkmacvwxktbh.supabase.co/rest/v1/${table}?select=*&limit=0`, {
                headers: {
                    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
                    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
                    'x-smarter-data-actor': 'service',
                    'x-smarter-data-protocol': '1',
                    'Accept': 'application/json',
                    'Prefer': 'return=representation'
                }
            });

            const contentRange = resp.headers.get('content-range');
            const contentProfile = resp.headers.get('content-profile');

            // Get columns from OpenAPI spec
            const specResp = await fetch(`https://kuklfnapbkmacvwxktbh.supabase.co/rest/v1/?select`, {
                headers: {
                    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
                    'x-smarter-data-actor': 'service',
                    'x-smarter-data-protocol': '1',
                    'Accept': 'application/openapi+json'
                }
            });

            if (specResp.ok) {
                const spec = await specResp.json();
                const def = spec.definitions?.[table];
                if (def && def.properties) {
                    const cols = Object.keys(def.properties);
                    const required = def.required || [];
                    console.log(`✅ ${table}: [${cols.join(', ')}]`);
                    console.log(`   required: [${required.join(', ')}]`);
                } else {
                    console.log(`⚠️ ${table}: no definition in spec`);
                }
            }
        } catch (e) {
            console.log(`❌ ${table}: ${e.message}`);
        }
    }
}

inspectEmpty().catch(console.error);
