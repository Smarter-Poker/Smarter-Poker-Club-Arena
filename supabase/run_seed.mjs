/**
 * Club JAQK Seed Data Runner — Supabase REST API
 * Uses @supabase/supabase-js with service_role key to INSERT all seed data.
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

const NOW = new Date();
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const DAYS = 86400000;
const HOURS = 3600000;
const MINS = 60000;

// ============================================================================
// HELPER: Upsert with error handling
// ============================================================================
async function upsert(table, data, opts = {}) {
    const { data: res, error } = await supabase
        .from(table)
        .upsert(data, { onConflict: opts.onConflict || 'id', ignoreDuplicates: true });
    if (error) {
        console.error(`  ❌ ${table}: ${error.message}`);
        return false;
    }
    console.log(`  ✅ ${table}: ${Array.isArray(data) ? data.length : 1} rows`);
    return true;
}

// ============================================================================
// 1. PROFILES (25 users)
// ============================================================================
async function seedProfiles() {
    console.log('\n♠ Part 1: Foundation');

    const users = [
        { id: '11111111-1111-1111-1111-111111111101', username: 'AceKing', display_name: 'Tony R.', player_number: 10001, xp: 8500, level: 42, vip_level: 'diamond', streak_days: 7, last_login: ago(1 * HOURS), stats: { total_hands: 15200, win_rate: 6.2 }, created_at: ago(90 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111102', username: 'QueenBee', display_name: 'Maria S.', player_number: 10002, xp: 6200, level: 31, vip_level: 'platinum', streak_days: 5, last_login: ago(2 * HOURS), stats: { total_hands: 8900, win_rate: 4.1 }, created_at: ago(85 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111103', username: 'Bluff_Master', display_name: 'Jake W.', player_number: 10003, xp: 7100, level: 36, vip_level: 'gold', streak_days: 3, last_login: ago(30 * MINS), stats: { total_hands: 12400, win_rate: 3.5 }, created_at: ago(80 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111104', username: 'FloatQueen', display_name: 'Sophia L.', player_number: 10004, xp: 5800, level: 29, vip_level: 'gold', streak_days: 6, last_login: ago(3 * HOURS), stats: { total_hands: 9200, win_rate: 5.1 }, created_at: ago(75 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111105', username: 'NitKing', display_name: 'Liam C.', player_number: 10005, xp: 4200, level: 21, vip_level: 'silver', streak_days: 4, last_login: ago(5 * HOURS), stats: { total_hands: 6800, win_rate: 2.8 }, created_at: ago(70 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111106', username: 'SuitedAce', display_name: 'Emma D.', player_number: 10006, xp: 3600, level: 18, vip_level: 'silver', streak_days: 2, last_login: ago(1 * DAYS), stats: { total_hands: 4500, win_rate: 1.2 }, created_at: ago(60 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111107', username: 'StackAttack', display_name: 'Noah P.', player_number: 10007, xp: 5100, level: 26, vip_level: 'gold', streak_days: 7, last_login: ago(45 * MINS), stats: { total_hands: 7800, win_rate: 7.3 }, created_at: ago(55 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111108', username: 'PotControl', display_name: 'Olivia M.', player_number: 10008, xp: 4800, level: 24, vip_level: 'gold', streak_days: 5, last_login: ago(2 * HOURS), stats: { total_hands: 6200, win_rate: 3.9 }, created_at: ago(50 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111109', username: 'Aggro_ETH', display_name: 'Ethan B.', player_number: 10009, xp: 6900, level: 35, vip_level: 'platinum', streak_days: 1, last_login: ago(6 * HOURS), stats: { total_hands: 11500, win_rate: -2.1 }, created_at: ago(45 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111110', username: 'MicroGrind', display_name: 'Ava K.', player_number: 10010, xp: 2100, level: 11, vip_level: 'bronze', streak_days: 3, last_login: ago(8 * HOURS), stats: { total_hands: 2200, win_rate: 0.5 }, created_at: ago(40 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111111', username: 'RiverRat', display_name: 'Lucas F.', player_number: 10011, xp: 3200, level: 16, vip_level: 'silver', streak_days: 0, last_login: ago(2 * DAYS), stats: { total_hands: 3800, win_rate: -4.2 }, created_at: ago(38 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111112', username: 'SetMiner', display_name: 'Mia G.', player_number: 10012, xp: 4100, level: 21, vip_level: 'silver', streak_days: 4, last_login: ago(3 * HOURS), stats: { total_hands: 5100, win_rate: 2.1 }, created_at: ago(35 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111113', username: '3BetMason', display_name: 'Mason H.', player_number: 10013, xp: 5500, level: 28, vip_level: 'gold', streak_days: 6, last_login: ago(1 * HOURS), stats: { total_hands: 8200, win_rate: 5.5 }, created_at: ago(32 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111114', username: 'PLOQueen', display_name: 'Charlotte V.', player_number: 10014, xp: 4700, level: 24, vip_level: 'gold', streak_days: 2, last_login: ago(4 * HOURS), stats: { total_hands: 6900, win_rate: 8.2 }, created_at: ago(30 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111115', username: 'TightJames', display_name: 'James T.', player_number: 10015, xp: 2800, level: 14, vip_level: 'bronze', streak_days: 1, last_login: ago(1 * DAYS), stats: { total_hands: 3100, win_rate: 1.8 }, created_at: ago(28 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111116', username: 'RunItTwice', display_name: 'Amelia N.', player_number: 10016, xp: 3900, level: 20, vip_level: 'silver', streak_days: 5, last_login: ago(5 * HOURS), stats: { total_hands: 4800, win_rate: 0.3 }, created_at: ago(26 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111117', username: 'BombPotBen', display_name: 'Benjamin O.', player_number: 10017, xp: 4400, level: 22, vip_level: 'silver', streak_days: 3, last_login: ago(2 * HOURS), stats: { total_hands: 5600, win_rate: -1.5 }, created_at: ago(24 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111118', username: 'HighHand', display_name: 'Harper Q.', player_number: 10018, xp: 3100, level: 16, vip_level: 'silver', streak_days: 7, last_login: ago(30 * MINS), stats: { total_hands: 3400, win_rate: 3.2 }, created_at: ago(22 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111119', username: 'DanTheMan', display_name: 'Daniel J.', player_number: 10019, xp: 2600, level: 13, vip_level: 'bronze', streak_days: 0, last_login: ago(3 * DAYS), stats: { total_hands: 2800, win_rate: -0.8 }, created_at: ago(20 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111120', username: 'EllaBluffs', display_name: 'Ella Y.', player_number: 10020, xp: 1800, level: 9, vip_level: 'bronze', streak_days: 2, last_login: ago(1 * DAYS), stats: { total_hands: 1900, win_rate: -3.1 }, created_at: ago(18 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111121', username: 'ShortStack', display_name: 'Alex Z.', player_number: 10021, xp: 2200, level: 11, vip_level: 'bronze', streak_days: 1, last_login: ago(12 * HOURS), stats: { total_hands: 2400, win_rate: 0.9 }, created_at: ago(16 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111122', username: 'GraceUnder', display_name: 'Grace U.', player_number: 10022, xp: 1500, level: 8, vip_level: 'bronze', streak_days: 0, last_login: ago(4 * DAYS), stats: { total_hands: 1100, win_rate: -1.2 }, created_at: ago(14 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111123', username: 'RyanRolls', display_name: 'Ryan I.', player_number: 10023, xp: 900, level: 5, vip_level: 'bronze', streak_days: 1, last_login: ago(2 * DAYS), stats: { total_hands: 800, win_rate: 2.5 }, created_at: ago(10 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111124', username: 'ChloeCalls', display_name: 'Chloe A.', player_number: 10024, xp: 600, level: 3, vip_level: 'bronze', streak_days: 0, last_login: ago(5 * DAYS), stats: { total_hands: 400, win_rate: -5.0 }, created_at: ago(7 * DAYS) },
        { id: '11111111-1111-1111-1111-111111111125', username: 'MaxValueBet', display_name: 'Max E.', player_number: 10025, xp: 300, level: 2, vip_level: 'bronze', streak_days: 0, last_login: ago(6 * DAYS), stats: { total_hands: 150, win_rate: 0.0 }, created_at: ago(3 * DAYS) },
    ];
    await upsert('profiles', users);
}

// ============================================================================
// 2. CLUB
// ============================================================================
async function seedClub() {
    await upsert('clubs', [{
        id: 'a0000000-0000-0000-0000-000000000001',
        club_id: 77777,
        name: 'Club JAQK',
        description: 'Premier online poker club — NLH, PLO, Short Deck, and Tournaments.',
        owner_id: '11111111-1111-1111-1111-111111111101',
        is_public: true,
        requires_approval: true,
        settings: { default_rake_percent: 5, rake_cap: 15, time_bank_seconds: 30, allow_straddle: true, allow_run_it_twice: true, min_buy_in_bb: 40, max_buy_in_bb: 200 },
        created_at: ago(90 * DAYS)
    }]);
}

// ============================================================================
// 3. CLUB MEMBERS (25)
// ============================================================================
async function seedMembers() {
    const m = (idx, uid, role, nick, bal, agentId, status, daysAgo) => ({
        id: `c0000000-0000-0000-0000-0000000000${idx.toString().padStart(2, '0')}`,
        club_id: 'a0000000-0000-0000-0000-000000000001',
        user_id: uid,
        role, nickname: nick,
        chip_balance: bal,
        agent_id: agentId,
        status,
        joined_at: ago(daysAgo * DAYS)
    });

    const agentJake = 'c0000000-0000-0000-0000-000000000003';
    const agentSophia = 'c0000000-0000-0000-0000-000000000004';
    const agentLiam = 'c0000000-0000-0000-0000-000000000005';

    const members = [
        m(1, '11111111-1111-1111-1111-111111111101', 'owner', 'AceKing', 250000, null, 'active', 90),
        m(2, '11111111-1111-1111-1111-111111111102', 'admin', 'QueenBee', 180000, null, 'active', 85),
        m(3, '11111111-1111-1111-1111-111111111103', 'agent', 'Bluff_Master', 120000, null, 'active', 80),
        m(4, '11111111-1111-1111-1111-111111111104', 'agent', 'FloatQueen', 95000, null, 'active', 75),
        m(5, '11111111-1111-1111-1111-111111111105', 'agent', 'NitKing', 75000, null, 'active', 70),
        m(6, '11111111-1111-1111-1111-111111111106', 'member', 'SuitedAce', 45000, agentJake, 'active', 60),
        m(7, '11111111-1111-1111-1111-111111111107', 'member', 'StackAttack', 68000, agentJake, 'active', 55),
        m(8, '11111111-1111-1111-1111-111111111108', 'member', 'PotControl', 52000, agentJake, 'active', 50),
        m(9, '11111111-1111-1111-1111-111111111109', 'member', 'Aggro_ETH', 91000, agentJake, 'active', 45),
        m(10, '11111111-1111-1111-1111-111111111110', 'member', 'MicroGrind', 12000, agentSophia, 'active', 40),
        m(11, '11111111-1111-1111-1111-111111111111', 'member', 'RiverRat', 18000, agentSophia, 'active', 38),
        m(12, '11111111-1111-1111-1111-111111111112', 'member', 'SetMiner', 35000, agentSophia, 'active', 35),
        m(13, '11111111-1111-1111-1111-111111111113', 'member', '3BetMason', 72000, agentSophia, 'active', 32),
        m(14, '11111111-1111-1111-1111-111111111114', 'member', 'PLOQueen', 58000, agentLiam, 'active', 30),
        m(15, '11111111-1111-1111-1111-111111111115', 'member', 'TightJames', 22000, agentLiam, 'active', 28),
        m(16, '11111111-1111-1111-1111-111111111116', 'member', 'RunItTwice', 41000, agentLiam, 'active', 26),
        m(17, '11111111-1111-1111-1111-111111111117', 'member', 'BombPotBen', 38000, agentLiam, 'active', 24),
        m(18, '11111111-1111-1111-1111-111111111118', 'member', 'HighHand', 29000, null, 'active', 22),
        m(19, '11111111-1111-1111-1111-111111111119', 'member', 'DanTheMan', 15000, null, 'active', 20),
        m(20, '11111111-1111-1111-1111-111111111120', 'member', 'EllaBluffs', 8500, null, 'active', 18),
        m(21, '11111111-1111-1111-1111-111111111121', 'member', 'ShortStack', 11000, null, 'active', 16),
        m(22, '11111111-1111-1111-1111-111111111122', 'member', 'GraceUnder', 6500, null, 'active', 14),
        m(23, '11111111-1111-1111-1111-111111111123', 'member', 'RyanRolls', 5000, null, 'pending', 2),
        m(24, '11111111-1111-1111-1111-111111111124', 'member', 'ChloeCalls', 2000, null, 'suspended', 7),
        m(25, '11111111-1111-1111-1111-111111111125', 'member', 'MaxValueBet', 1000, null, 'active', 3),
    ];
    await upsert('club_members', members);
}

// ============================================================================
// 4. AGENTS
// ============================================================================
async function seedAgents() {
    await upsert('agents', [
        { id: 'd0000000-0000-0000-0000-000000000001', club_id: 'a0000000-0000-0000-0000-000000000001', user_id: '11111111-1111-1111-1111-111111111103', member_id: 'c0000000-0000-0000-0000-000000000003', name: 'Jake (Bluff_Master)', chip_balance: 500000, commission_rate: 12, player_count: 4, is_active: true, created_at: ago(80 * DAYS) },
        { id: 'd0000000-0000-0000-0000-000000000002', club_id: 'a0000000-0000-0000-0000-000000000001', user_id: '11111111-1111-1111-1111-111111111104', member_id: 'c0000000-0000-0000-0000-000000000004', name: 'Sophia (FloatQueen)', chip_balance: 350000, commission_rate: 10, player_count: 4, is_active: true, created_at: ago(75 * DAYS) },
        { id: 'd0000000-0000-0000-0000-000000000003', club_id: 'a0000000-0000-0000-0000-000000000001', user_id: '11111111-1111-1111-1111-111111111105', member_id: 'c0000000-0000-0000-0000-000000000005', name: 'Liam (NitKing)', chip_balance: 200000, commission_rate: 8, player_count: 4, is_active: true, created_at: ago(70 * DAYS) },
    ]);
}

// ============================================================================
// 5. TABLES (8)
// ============================================================================
async function seedTables() {
    console.log('\n♠ Part 2: Tables & Games');
    const t = (idx, name, game, stakes, sb, bb, minBuy, maxBuy, maxP, pCount, status, settings, daysAgo) => ({
        id: `f0000000-0000-0000-0000-0000000000${idx.toString().padStart(2, '0')}`,
        club_id: 'a0000000-0000-0000-0000-000000000001',
        name, game_type: game, stakes, small_blind: sb, big_blind: bb,
        min_buy_in: minBuy, max_buy_in: maxBuy, max_players: maxP,
        player_count: pCount, status, settings, created_at: ago(daysAgo * DAYS)
    });

    await upsert('tables', [
        t(1, 'JAQK Micro', 'NLH', '0.25/0.50', 0.25, 0.50, 20, 50, 9, 6, 'active', { ante: 0, straddle: false, bomb_pot: false, run_it_twice: true }, 60),
        t(2, 'JAQK Low', 'NLH', '0.50/1.00', 0.50, 1.00, 40, 100, 9, 8, 'active', { ante: 0, straddle: true, bomb_pot: false, run_it_twice: true }, 55),
        t(3, 'JAQK Mid', 'NLH', '1/2', 1, 2, 80, 200, 9, 5, 'active', { ante: 0.25, straddle: true, bomb_pot: true, run_it_twice: true }, 50),
        t(4, 'JAQK High', 'NLH', '2/5', 2, 5, 200, 500, 6, 4, 'active', { ante: 0.50, straddle: true, bomb_pot: true, run_it_twice: true }, 45),
        t(5, 'JAQK PLO Action', 'PLO', '0.50/1.00', 0.50, 1, 40, 200, 6, 5, 'active', { ante: 0, straddle: true, bomb_pot: true, run_it_twice: true }, 40),
        t(6, 'JAQK PLO High', 'PLO', '1/2', 1, 2, 80, 400, 6, 3, 'active', { ante: 0, straddle: true, bomb_pot: true, run_it_twice: true }, 35),
        t(7, 'JAQK Short Deck', 'NLH', '1/2 (SD)', 1, 2, 80, 200, 6, 4, 'active', { ante: 2, straddle: false, short_deck: true }, 30),
        t(8, 'JAQK VIP Nosebleed', 'NLH', '5/10', 5, 10, 500, 2000, 6, 0, 'waiting', { ante: 1, straddle: true, bomb_pot: true }, 20),
    ]);
}

// ============================================================================
// 6. TOURNAMENTS
// ============================================================================
async function seedTournaments() {
    await upsert('tournaments', [
        { id: 'f1000000-0000-0000-0000-000000000001', club_id: 'a0000000-0000-0000-0000-000000000001', name: 'JAQK Sunday Major', game_type: 'NLH', buy_in: 50, starting_chips: 10000, max_players: 50, current_players: 28, status: 'running', prize_pool: 1400, blind_level: 5, blind_increase_minutes: 15, settings: { rebuy: true, addon: true }, starts_at: ago(2 * HOURS), created_at: ago(3 * DAYS) },
        { id: 'f1000000-0000-0000-0000-000000000002', club_id: 'a0000000-0000-0000-0000-000000000001', name: 'JAQK Nightly Turbo', game_type: 'NLH', buy_in: 20, starting_chips: 5000, max_players: 30, current_players: 12, status: 'registering', prize_pool: 0, blind_level: 1, blind_increase_minutes: 8, settings: { rebuy: false, turbo: true }, starts_at: new Date(NOW.getTime() + 2 * HOURS).toISOString(), created_at: ago(1 * DAYS) },
        { id: 'f1000000-0000-0000-0000-000000000003', club_id: 'a0000000-0000-0000-0000-000000000001', name: 'JAQK SNG Express', game_type: 'NLH', buy_in: 10, starting_chips: 3000, max_players: 9, current_players: 9, status: 'completed', prize_pool: 90, blind_level: 10, blind_increase_minutes: 10, settings: { sng: true }, starts_at: ago(1 * DAYS), created_at: ago(2 * DAYS) },
        { id: 'f1000000-0000-0000-0000-000000000004', club_id: 'a0000000-0000-0000-0000-000000000001', name: 'JAQK PLO Championship', game_type: 'PLO', buy_in: 100, starting_chips: 15000, max_players: 30, current_players: 22, status: 'running', prize_pool: 2200, blind_level: 4, blind_increase_minutes: 20, settings: { rebuy: true, addon: true }, starts_at: ago(3 * HOURS), created_at: ago(5 * DAYS) },
    ]);
}

// ============================================================================
// 7. NOTIFICATIONS
// ============================================================================
async function seedNotifications() {
    console.log('\n♠ Part 3: Financial & Social');
    await upsert('notifications', [
        { id: 'ad000000-0000-0000-0000-000000000001', user_id: '11111111-1111-1111-1111-111111111101', type: 'achievement', title: 'Achievement Unlocked!', message: "You've earned VIP Diamond status! 💎", is_read: true, action_url: '/profile', created_at: ago(10 * DAYS) },
        { id: 'ad000000-0000-0000-0000-000000000002', user_id: '11111111-1111-1111-1111-111111111101', type: 'tournament_start', title: 'Tournament Starting!', message: 'JAQK Sunday Major begins in 5 minutes', is_read: true, action_url: '/tournaments', created_at: ago(2 * HOURS) },
        { id: 'ad000000-0000-0000-0000-000000000003', user_id: '11111111-1111-1111-1111-111111111102', type: 'system', title: 'Welcome to Club JAQK', message: "You've been promoted to Admin! 🎉", is_read: true, action_url: '/club', created_at: ago(84 * DAYS) },
        { id: 'ad000000-0000-0000-0000-000000000004', user_id: '11111111-1111-1111-1111-111111111107', type: 'bonus', title: 'Daily Bonus Ready!', message: "Spin the wheel for today's reward", is_read: false, action_url: '/daily-bonus', created_at: ago(2 * HOURS) },
        { id: 'ad000000-0000-0000-0000-000000000005', user_id: '11111111-1111-1111-1111-111111111109', type: 'settlement', title: 'Weekly Settlement', message: 'Your weekly results are ready to view', is_read: false, action_url: '/financials', created_at: ago(1 * DAYS) },
        { id: 'ad000000-0000-0000-0000-000000000006', user_id: '11111111-1111-1111-1111-111111111106', type: 'table_ready', title: 'Seat Available!', message: 'A seat is open at JAQK Mid table', is_read: true, action_url: '/tables', created_at: ago(3 * HOURS) },
        { id: 'ad000000-0000-0000-0000-000000000007', user_id: '11111111-1111-1111-1111-111111111113', type: 'friend_request', title: 'New Friend Request', message: 'StackAttack wants to be your friend', is_read: false, action_url: '/friends', created_at: ago(5 * HOURS) },
        { id: 'ad000000-0000-0000-0000-000000000008', user_id: '11111111-1111-1111-1111-111111111114', type: 'club_invite', title: 'Tournament Invite', message: "You're invited to the PLO Championship!", is_read: true, action_url: '/tournaments', created_at: ago(5 * DAYS) },
        { id: 'ad000000-0000-0000-0000-000000000009', user_id: '11111111-1111-1111-1111-111111111103', type: 'settlement', title: 'Agent Commission', message: 'Your weekly commission of 1,240 has been credited', is_read: true, action_url: '/agent/dashboard', created_at: ago(7 * DAYS) },
        { id: 'ad000000-0000-0000-0000-000000000010', user_id: '11111111-1111-1111-1111-111111111125', type: 'system', title: 'Welcome!', message: 'Welcome to Club JAQK! Start playing now 🃏', is_read: false, action_url: '/lobby', created_at: ago(3 * DAYS) },
    ]);
}

// ============================================================================
// 8. CLUB ANNOUNCEMENTS
// ============================================================================
async function seedAnnouncements() {
    await upsert('club_announcements', [
        { id: 'b2000000-0000-0000-0000-000000000001', club_id: 'a0000000-0000-0000-0000-000000000001', author_id: '11111111-1111-1111-1111-111111111101', title: '🎉 Welcome to Club JAQK!', content: 'Welcome to our new poker club! We offer NLH, PLO, and Short Deck tables with stakes from micro to high.', is_pinned: true, created_at: ago(89 * DAYS) },
        { id: 'b2000000-0000-0000-0000-000000000002', club_id: 'a0000000-0000-0000-0000-000000000001', author_id: '11111111-1111-1111-1111-111111111101', title: '🏆 Sunday Major — Every Week', content: 'Our flagship tournament runs every Sunday at 7 PM. $50 buy-in, $1,000 GTD.', is_pinned: true, created_at: ago(60 * DAYS) },
        { id: 'b2000000-0000-0000-0000-000000000003', club_id: 'a0000000-0000-0000-0000-000000000001', author_id: '11111111-1111-1111-1111-111111111102', title: '📋 New Table Rules', content: 'All NLH tables now support Run It Twice. Straddle available on 0.50/1.00 and above.', is_pinned: false, created_at: ago(30 * DAYS) },
        { id: 'b2000000-0000-0000-0000-000000000004', club_id: 'a0000000-0000-0000-0000-000000000001', author_id: '11111111-1111-1111-1111-111111111101', title: '🎊 New PLO Championship Added!', content: "By popular demand, we're launching a monthly PLO Championship! $100 buy-in, 30 player max.", is_pinned: false, created_at: ago(6 * DAYS) },
    ]);
}

// ============================================================================
// 9. PROMOTIONS
// ============================================================================
async function seedPromotions() {
    await upsert('promotions', [
        { id: 'b3000000-0000-0000-0000-000000000001', club_id: 'a0000000-0000-0000-0000-000000000001', name: 'February Rake Race', description: 'Play the most hands and win prizes!', type: 'rake_race', start_date: ago(15 * DAYS), end_date: new Date(NOW.getTime() + 15 * DAYS).toISOString(), status: 'active', prize_pool: 5000, opt_in_required: true, is_featured: true },
        { id: 'b3000000-0000-0000-0000-000000000002', club_id: 'a0000000-0000-0000-0000-000000000001', name: 'High Hand of the Week', description: 'Best hand each week wins the pot!', type: 'high_hand', start_date: ago(3 * DAYS), end_date: new Date(NOW.getTime() + 4 * DAYS).toISOString(), status: 'active', prize_pool: 1000, opt_in_required: false, is_featured: true },
        { id: 'b3000000-0000-0000-0000-000000000003', club_id: 'a0000000-0000-0000-0000-000000000001', name: 'New Member Freeroll', description: 'Free tournament for members who joined this month', type: 'milestone', start_date: new Date(NOW.getTime() + 5 * DAYS).toISOString(), end_date: new Date(NOW.getTime() + 5 * DAYS + 4 * HOURS).toISOString(), status: 'scheduled', prize_pool: 500, opt_in_required: true, is_featured: false },
        { id: 'b3000000-0000-0000-0000-000000000004', club_id: 'a0000000-0000-0000-0000-000000000001', name: 'January Grinder Award', description: 'Most hands played in January wins!', type: 'leaderboard', start_date: ago(45 * DAYS), end_date: ago(15 * DAYS), status: 'completed', prize_pool: 3000, opt_in_required: false, is_featured: false },
    ]);
}

// ============================================================================
// 10. FRIENDSHIPS
// ============================================================================
async function seedFriendships() {
    await upsert('friendships', [
        { id: 'af000000-0000-0000-0000-000000000001', user_id: '11111111-1111-1111-1111-111111111101', friend_id: '11111111-1111-1111-1111-111111111102' },
        { id: 'af000000-0000-0000-0000-000000000002', user_id: '11111111-1111-1111-1111-111111111102', friend_id: '11111111-1111-1111-1111-111111111101' },
        { id: 'af000000-0000-0000-0000-000000000003', user_id: '11111111-1111-1111-1111-111111111107', friend_id: '11111111-1111-1111-1111-111111111109' },
        { id: 'af000000-0000-0000-0000-000000000004', user_id: '11111111-1111-1111-1111-111111111109', friend_id: '11111111-1111-1111-1111-111111111107' },
        { id: 'af000000-0000-0000-0000-000000000005', user_id: '11111111-1111-1111-1111-111111111103', friend_id: '11111111-1111-1111-1111-111111111106' },
        { id: 'af000000-0000-0000-0000-000000000006', user_id: '11111111-1111-1111-1111-111111111106', friend_id: '11111111-1111-1111-1111-111111111103' },
        { id: 'af000000-0000-0000-0000-000000000007', user_id: '11111111-1111-1111-1111-111111111113', friend_id: '11111111-1111-1111-1111-111111111114' },
        { id: 'af000000-0000-0000-0000-000000000008', user_id: '11111111-1111-1111-1111-111111111114', friend_id: '11111111-1111-1111-1111-111111111113' },
        { id: 'af000000-0000-0000-0000-000000000009', user_id: '11111111-1111-1111-1111-111111111101', friend_id: '11111111-1111-1111-1111-111111111107' },
        { id: 'af000000-0000-0000-0000-000000000010', user_id: '11111111-1111-1111-1111-111111111107', friend_id: '11111111-1111-1111-1111-111111111101' },
    ]);
}

// ============================================================================
// 11. DIRECT MESSAGES  
// ============================================================================
async function seedMessages() {
    await upsert('direct_messages', [
        { id: 'ae000000-0000-0000-0000-000000000001', sender_id: '11111111-1111-1111-1111-111111111101', recipient_id: '11111111-1111-1111-1111-111111111102', content: 'Hey Maria, can you review the new member applications?', is_read: true, created_at: ago(2 * DAYS) },
        { id: 'ae000000-0000-0000-0000-000000000002', sender_id: '11111111-1111-1111-1111-111111111102', recipient_id: '11111111-1111-1111-1111-111111111101', content: "Sure thing! I'll handle them this afternoon.", is_read: true, created_at: ago(2 * DAYS - 15 * MINS) },
        { id: 'ae000000-0000-0000-0000-000000000003', sender_id: '11111111-1111-1111-1111-111111111107', recipient_id: '11111111-1111-1111-1111-111111111109', content: 'GG on that hand! That was a sick call.', is_read: true, created_at: ago(1 * DAYS) },
        { id: 'ae000000-0000-0000-0000-000000000004', sender_id: '11111111-1111-1111-1111-111111111109', recipient_id: '11111111-1111-1111-1111-111111111107', content: 'Haha thanks, I had a read on you 😏', is_read: true, created_at: ago(1 * DAYS - 5 * MINS) },
    ]);
}

// ============================================================================
// 12. CHIP TRANSACTIONS
// ============================================================================
async function seedChipTransactions() {
    await upsert('chip_transactions', [
        { id: 'aa000000-0000-0000-0000-000000000001', club_id: 'a0000000-0000-0000-0000-000000000001', user_id: '11111111-1111-1111-1111-111111111101', type: 'deposit', amount: 50000, balance_after: 50000, reference: 'Initial deposit', approved_by: '11111111-1111-1111-1111-111111111101', status: 'completed', created_at: ago(30 * DAYS) },
        { id: 'aa000000-0000-0000-0000-000000000002', club_id: 'a0000000-0000-0000-0000-000000000001', user_id: '11111111-1111-1111-1111-111111111106', type: 'deposit', amount: 10000, balance_after: 10000, reference: 'Agent ref: Jake', approved_by: '11111111-1111-1111-1111-111111111103', status: 'completed', created_at: ago(28 * DAYS) },
        { id: 'aa000000-0000-0000-0000-000000000003', club_id: 'a0000000-0000-0000-0000-000000000001', user_id: '11111111-1111-1111-1111-111111111107', type: 'deposit', amount: 20000, balance_after: 20000, reference: 'Agent ref: Jake', approved_by: '11111111-1111-1111-1111-111111111103', status: 'completed', created_at: ago(27 * DAYS) },
        { id: 'aa000000-0000-0000-0000-000000000004', club_id: 'a0000000-0000-0000-0000-000000000001', user_id: '11111111-1111-1111-1111-111111111109', type: 'deposit', amount: 30000, balance_after: 30000, reference: 'Agent ref: Jake', approved_by: '11111111-1111-1111-1111-111111111103', status: 'completed', created_at: ago(21 * DAYS) },
        { id: 'aa000000-0000-0000-0000-000000000005', club_id: 'a0000000-0000-0000-0000-000000000001', user_id: '11111111-1111-1111-1111-111111111101', type: 'withdrawal', amount: -15000, balance_after: 235000, reference: 'Weekly withdrawal', approved_by: '11111111-1111-1111-1111-111111111101', status: 'completed', created_at: ago(20 * DAYS) },
        { id: 'aa000000-0000-0000-0000-000000000006', club_id: 'a0000000-0000-0000-0000-000000000001', user_id: '11111111-1111-1111-1111-111111111125', type: 'deposit', amount: 1000, balance_after: 1000, reference: 'Sign-up bonus', status: 'completed', created_at: ago(3 * DAYS) },
    ]);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
    console.log('♠ Club JAQK Seed Data Runner (Supabase REST API)');
    console.log('═'.repeat(60));

    // Part 1: Foundation
    await seedProfiles();
    await seedClub();
    await seedMembers();
    await seedAgents();

    // Part 2: Tables & Games
    await seedTables();
    await seedTournaments();

    // Part 3: Financial & Social
    await seedNotifications();
    await seedAnnouncements();
    await seedPromotions();
    await seedFriendships();
    await seedMessages();
    await seedChipTransactions();

    console.log('\n' + '═'.repeat(60));
    console.log('♠ CLUB JAQK SEED COMPLETE!');
    console.log('  → 25 users  |  8 tables  |  4 tournaments  |  30 days');
    console.log('═'.repeat(60));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
