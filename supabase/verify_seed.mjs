/**
 * Final verification — count rows in all seeded tables
 */
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
    'https://kuklfnapbkmacvwxktbh.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

const TABLES = [
    'profiles', 'clubs', 'club_members', 'agents', 'unions', 'union_clubs', 'diamond_wallets',
    'tables', 'table_seats', 'tournaments', 'hands', 'horses', 'spin_tournaments',
    'notifications', 'club_announcements', 'promotions', 'friendships', 'friend_requests',
    'direct_messages', 'chip_transactions', 'daily_spins', 'player_stats',
    'rake_records', 'settlement_periods', 'club_financial_summary', 'club_transactions',
    // agent_commissions replaced commission_records, which phase 7 dropped on
    // 2026-09-01 after it held zero rows for its whole life while the app read it.
    'agent_commissions', 'training_progress', 'vip_feature_usage', 'wallet_transactions',
    'user_achievements', 'achievements', 'messages'
];

async function verify() {
    console.log('♠ SEED VERIFICATION — Row Counts\n');
    let total = 0, seeded = 0;
    for (const t of TABLES) {
        const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
        if (error) {
            console.log(`  ❌ ${t.padEnd(25)} — ${error.message}`);
        } else {
            const icon = count > 0 ? '✅' : '📦';
            console.log(`  ${icon} ${t.padEnd(25)} ${count} rows`);
            total += count;
            if (count > 0) seeded++;
        }
    }
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  TOTAL: ${total} rows across ${seeded} populated tables`);
    console.log('═'.repeat(50));
}

verify().catch(console.error);
