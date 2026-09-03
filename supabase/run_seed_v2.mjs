/**
 * Club JAQK Seed v2 — Matches LIVE schema columns exactly
 */
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
    'https://kuklfnapbkmacvwxktbh.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);
const D = 86400000, H = 3600000, M = 60000, NOW = Date.now();
const ago = ms => new Date(NOW - ms).toISOString();
const fwd = ms => new Date(NOW + ms).toISOString();

async function up(table, data, onConflict = 'id') {
    const { error } = await supabase.from(table).upsert(data, { onConflict, ignoreDuplicates: true });
    if (error) console.error(`  ❌ ${table}: ${error.message}`);
    else console.log(`  ✅ ${table}: ${Array.isArray(data) ? data.length : 1} rows`);
    return !error;
}

const U = i => `11111111-1111-1111-1111-1111111111${i.toString().padStart(2, '0')}`;
const CLUB = 'a0000000-0000-0000-0000-000000000001';

async function main() {
    console.log('♠ Club JAQK Seed v2');

    // --- PROFILES (live cols: id,username,display_name,xp_total,vip_tier,streak_count,last_active,player_number,full_name,diamonds,avatar_url,is_online,last_seen,role,created_at,last_login,bio,favorite_game) ---
    console.log('\n♠ Profiles');
    const profiles = [
        [1, 'AceKing', 'Tony R.', 8500, 'diamond', 7, 1 * H, 10001],
        [2, 'QueenBee', 'Maria S.', 6200, 'platinum', 5, 2 * H, 10002],
        [3, 'Bluff_Master', 'Jake W.', 7100, 'gold', 3, 30 * M, 10003],
        [4, 'FloatQueen', 'Sophia L.', 5800, 'gold', 6, 3 * H, 10004],
        [5, 'NitKing', 'Liam C.', 4200, 'silver', 4, 5 * H, 10005],
        [6, 'SuitedAce', 'Emma D.', 3600, 'silver', 2, 1 * D, 10006],
        [7, 'StackAttack', 'Noah P.', 5100, 'gold', 7, 45 * M, 10007],
        [8, 'PotControl', 'Olivia M.', 4800, 'gold', 5, 2 * H, 10008],
        [9, 'Aggro_ETH', 'Ethan B.', 6900, 'platinum', 1, 6 * H, 10009],
        [10, 'MicroGrind', 'Ava K.', 2100, 'bronze', 3, 8 * H, 10010],
        [11, 'RiverRat', 'Lucas F.', 3200, 'silver', 0, 2 * D, 10011],
        [12, 'SetMiner', 'Mia G.', 4100, 'silver', 4, 3 * H, 10012],
        [13, '3BetMason', 'Mason H.', 5500, 'gold', 6, 1 * H, 10013],
        [14, 'PLOQueen', 'Charlotte V.', 4700, 'gold', 2, 4 * H, 10014],
        [15, 'TightJames', 'James T.', 2800, 'bronze', 1, 1 * D, 10015],
        [16, 'RunItTwice', 'Amelia N.', 3900, 'silver', 5, 5 * H, 10016],
        [17, 'BombPotBen', 'Benjamin O.', 4400, 'silver', 3, 2 * H, 10017],
        [18, 'HighHand', 'Harper Q.', 3100, 'silver', 7, 30 * M, 10018],
        [19, 'DanTheMan', 'Daniel J.', 2600, 'bronze', 0, 3 * D, 10019],
        [20, 'EllaBluffs', 'Ella Y.', 1800, 'bronze', 2, 1 * D, 10020],
        [21, 'ShortStack', 'Alex Z.', 2200, 'bronze', 1, 12 * H, 10021],
        [22, 'GraceUnder', 'Grace U.', 1500, 'bronze', 0, 4 * D, 10022],
        [23, 'RyanRolls', 'Ryan I.', 900, 'bronze', 1, 2 * D, 10023],
        [24, 'ChloeCalls', 'Chloe A.', 600, 'bronze', 0, 5 * D, 10024],
        [25, 'MaxValueBet', 'Max E.', 300, 'bronze', 0, 6 * D, 10025],
    ].map(([i, un, dn, xp, vip, streak, lastAgo, pn]) => ({
        id: U(i), username: un, display_name: dn, full_name: dn, xp_total: xp, vip_tier: vip,
        streak_count: streak, last_active: ago(lastAgo), player_number: pn, is_online: lastAgo < 2 * H,
        last_login: ago(lastAgo), created_at: ago((95 - i * 3) * D)
    }));
    await up('profiles', profiles);

    // --- CLUB ---
    console.log('\n♠ Club');
    await up('clubs', [{
        id: CLUB, club_id: 77777, name: 'Club JAQK',
        description: 'Premier online poker club — NLH, PLO, Short Deck, and Tournaments.',
        owner_id: U(1), is_public: true, requires_approval: true,
        settings: { default_rake_percent: 5, rake_cap: 15, allow_straddle: true, allow_run_it_twice: true },
        chip_treasury: 500000, total_rake: 48500, online_count: 12,
        game_types: ['NLH', 'PLO', 'Short Deck'], member_count: 25, table_count: 8,
        created_at: ago(90 * D)
    }]);

    // --- CLUB MEMBERS (live: club_id,user_id,role,agent_id,joined_at,status,chip_balance,nickname,is_active) ---
    console.log('\n♠ Members');
    const agJ = 'c0000000-0000-0000-0000-000000000003', agS = 'c0000000-0000-0000-0000-000000000004', agL = 'c0000000-0000-0000-0000-000000000005';
    const members = [
        [1, 'owner', 'AceKing', 250000, null, 'active', 90],
        [2, 'admin', 'QueenBee', 180000, null, 'active', 85],
        [3, 'agent', 'Bluff_Master', 120000, null, 'active', 80],
        [4, 'agent', 'FloatQueen', 95000, null, 'active', 75],
        [5, 'agent', 'NitKing', 75000, null, 'active', 70],
        [6, 'member', 'SuitedAce', 45000, agJ, 'active', 60],
        [7, 'member', 'StackAttack', 68000, agJ, 'active', 55],
        [8, 'member', 'PotControl', 52000, agJ, 'active', 50],
        [9, 'member', 'Aggro_ETH', 91000, agJ, 'active', 45],
        [10, 'member', 'MicroGrind', 12000, agS, 'active', 40],
        [11, 'member', 'RiverRat', 18000, agS, 'active', 38],
        [12, 'member', 'SetMiner', 35000, agS, 'active', 35],
        [13, 'member', '3BetMason', 72000, agS, 'active', 32],
        [14, 'member', 'PLOQueen', 58000, agL, 'active', 30],
        [15, 'member', 'TightJames', 22000, agL, 'active', 28],
        [16, 'member', 'RunItTwice', 41000, agL, 'active', 26],
        [17, 'member', 'BombPotBen', 38000, agL, 'active', 24],
        [18, 'member', 'HighHand', 29000, null, 'active', 22],
        [19, 'member', 'DanTheMan', 15000, null, 'active', 20],
        [20, 'member', 'EllaBluffs', 8500, null, 'active', 18],
        [21, 'member', 'ShortStack', 11000, null, 'active', 16],
        [22, 'member', 'GraceUnder', 6500, null, 'active', 14],
        [23, 'member', 'RyanRolls', 5000, null, 'pending', 2],
        [24, 'member', 'ChloeCalls', 2000, null, 'suspended', 7],
        [25, 'member', 'MaxValueBet', 1000, null, 'active', 3],
    ].map(([i, role, nick, bal, agent, status, dAgo]) => ({
        club_id: CLUB, user_id: U(i), role, nickname: nick, chip_balance: bal,
        agent_id: agent, status, is_active: status === 'active', joined_at: ago(dAgo * D)
    }));
    await up('club_members', members, 'club_id,user_id');

    // --- AGENTS (live: id,user_id,club_id,membership_id,role,status,commission_rate,...) ---
    console.log('\n♠ Agents');
    await up('agents', [
        { id: 'd0000000-0000-0000-0000-000000000001', user_id: U(3), club_id: CLUB, membership_id: agJ, role: 'agent', status: 'active', commission_rate: 12, player_rakeback_rate: 5, credit_limit: 100000, credit_used: 0, is_prepaid: false, business_balance: 500000, player_balance: 0, promo_balance: 0, total_players: 4, active_player_count: 4, sub_agent_count: 0, weekly_rake_generated: 2800, lifetime_earnings: 8160, joined_at: ago(80 * D), created_at: ago(80 * D), updated_at: ago(1 * D) },
        { id: 'd0000000-0000-0000-0000-000000000002', user_id: U(4), club_id: CLUB, membership_id: agS, role: 'agent', status: 'active', commission_rate: 10, player_rakeback_rate: 5, credit_limit: 75000, credit_used: 0, is_prepaid: false, business_balance: 350000, player_balance: 0, promo_balance: 0, total_players: 4, active_player_count: 4, sub_agent_count: 0, weekly_rake_generated: 1750, lifetime_earnings: 4400, joined_at: ago(75 * D), created_at: ago(75 * D), updated_at: ago(2 * D) },
        { id: 'd0000000-0000-0000-0000-000000000003', user_id: U(5), club_id: CLUB, membership_id: agL, role: 'agent', status: 'active', commission_rate: 8, player_rakeback_rate: 5, credit_limit: 50000, credit_used: 0, is_prepaid: false, business_balance: 200000, player_balance: 0, promo_balance: 0, total_players: 4, active_player_count: 4, sub_agent_count: 0, weekly_rake_generated: 1280, lifetime_earnings: 2520, joined_at: ago(70 * D), created_at: ago(70 * D), updated_at: ago(1 * D) },
    ]);

    // --- DIAMOND WALLETS ---
    console.log('\n♠ Diamond Wallets');
    const wallets = profiles.map((p, i) => {
        const bal = Math.max(50, 15000 - i * 600);
        return { id: `e0000000-0000-0000-0000-0000000000${(i + 1).toString().padStart(2, '0')}`, user_id: p.id, balance: bal, lifetime_earned: Math.round(bal * 1.5), lifetime_spent: Math.round(bal * 0.5) };
    });
    await up('diamond_wallets', wallets);

    // --- UNIONS ---
    console.log('\n♠ Union');
    await up('unions', [{ id: 'b0000000-0000-0000-0000-000000000001', name: 'Aces United', description: 'Multi-club network for elite poker clubs', owner_id: U(1), is_public: true, member_count: 1, club_count: 1, total_rake: 48500, settings: { revenue_share: 10, shared_pool: true }, created_at: ago(60 * D) }]);
    await up('union_clubs', [{ id: 'b1000000-0000-0000-0000-000000000001', union_id: 'b0000000-0000-0000-0000-000000000001', club_id: CLUB, joined_at: ago(58 * D) }]);

    // --- TABLES (live: id,club_id,name,game_type,stakes,small_blind,big_blind,min_buy_in,max_buy_in,max_players,current_players,status,settings) ---
    console.log('\n♠ Tables');
    await up('tables', [
        { id: 'f0000000-0000-0000-0000-000000000001', club_id: CLUB, name: 'JAQK Micro', game_type: 'NLH', stakes: '0.25/0.50', small_blind: 0.25, big_blind: 0.5, min_buy_in: 20, max_buy_in: 50, max_players: 9, current_players: 6, status: 'active', settings: { run_it_twice: true }, created_at: ago(60 * D) },
        { id: 'f0000000-0000-0000-0000-000000000002', club_id: CLUB, name: 'JAQK Low', game_type: 'NLH', stakes: '0.50/1.00', small_blind: 0.5, big_blind: 1, min_buy_in: 40, max_buy_in: 100, max_players: 9, current_players: 8, status: 'active', settings: { straddle: true, run_it_twice: true }, created_at: ago(55 * D) },
        { id: 'f0000000-0000-0000-0000-000000000003', club_id: CLUB, name: 'JAQK Mid', game_type: 'NLH', stakes: '1/2', small_blind: 1, big_blind: 2, min_buy_in: 80, max_buy_in: 200, max_players: 9, current_players: 5, status: 'active', settings: { ante: 0.25, straddle: true, bomb_pot: true }, created_at: ago(50 * D) },
        { id: 'f0000000-0000-0000-0000-000000000004', club_id: CLUB, name: 'JAQK High', game_type: 'NLH', stakes: '2/5', small_blind: 2, big_blind: 5, min_buy_in: 200, max_buy_in: 500, max_players: 6, current_players: 4, status: 'active', settings: { ante: 0.5, straddle: true, bomb_pot: true }, created_at: ago(45 * D) },
        { id: 'f0000000-0000-0000-0000-000000000005', club_id: CLUB, name: 'JAQK PLO Action', game_type: 'PLO', stakes: '0.50/1.00', small_blind: 0.5, big_blind: 1, min_buy_in: 40, max_buy_in: 200, max_players: 6, current_players: 5, status: 'active', settings: { bomb_pot: true, run_it_twice: true }, created_at: ago(40 * D) },
        { id: 'f0000000-0000-0000-0000-000000000006', club_id: CLUB, name: 'JAQK PLO High', game_type: 'PLO', stakes: '1/2', small_blind: 1, big_blind: 2, min_buy_in: 80, max_buy_in: 400, max_players: 6, current_players: 3, status: 'active', settings: { straddle: true, bomb_pot: true }, created_at: ago(35 * D) },
        { id: 'f0000000-0000-0000-0000-000000000007', club_id: CLUB, name: 'JAQK Short Deck', game_type: 'NLH', stakes: '1/2 (SD)', small_blind: 1, big_blind: 2, min_buy_in: 80, max_buy_in: 200, max_players: 6, current_players: 4, status: 'active', settings: { ante: 2, short_deck: true }, created_at: ago(30 * D) },
        { id: 'f0000000-0000-0000-0000-000000000008', club_id: CLUB, name: 'JAQK VIP Nosebleed', game_type: 'NLH', stakes: '5/10', small_blind: 5, big_blind: 10, min_buy_in: 500, max_buy_in: 2000, max_players: 6, current_players: 0, status: 'waiting', settings: { ante: 1, straddle: true }, created_at: ago(20 * D) },
    ]);

    // --- TABLE SEATS (live: id,table_id,seat_number,user_id,stack,is_sitting_out,joined_at) ---
    console.log('\n♠ Table Seats');
    const seats = [
        ['01', '01', U(10), 1, 45], ['02', '01', U(20), 2, 32.5], ['03', '01', U(21), 4, 50], ['04', '01', U(22), 5, 28.75], ['05', '01', U(19), 7, 41], ['06', '01', U(15), 9, 50],
        ['07', '02', U(6), 1, 95], ['08', '02', U(7), 2, 145], ['09', '02', U(8), 3, 72], ['10', '02', U(11), 4, 88.5], ['11', '02', U(12), 5, 100], ['12', '02', U(16), 6, 67], ['13', '02', U(17), 8, 110], ['14', '02', U(18), 9, 82],
        ['15', '03', U(1), 1, 420], ['16', '03', U(3), 3, 380], ['17', '03', U(9), 5, 510], ['18', '03', U(13), 7, 290], ['19', '03', U(4), 9, 350],
        ['20', '04', U(1), 1, 980], ['21', '04', U(7), 2, 750], ['22', '04', U(9), 4, 1200], ['23', '04', U(14), 6, 620],
        ['24', '05', U(14), 1, 180], ['25', '05', U(9), 2, 240], ['26', '05', U(7), 3, 150], ['27', '05', U(17), 5, 95], ['28', '05', U(13), 6, 200],
    ].map(([si, ti, uid, seat, stack]) => ({
        id: `f3000000-0000-0000-0000-0000000000${si}`, table_id: `f0000000-0000-0000-0000-0000000000${ti}`,
        user_id: uid, seat_number: seat, stack, is_sitting_out: false, joined_at: ago(3 * H)
    }));
    await up('table_seats', seats);

    // --- TOURNAMENTS (live: id,name,game_type,buy_in_amount,buy_in_fee,start_time,status,max_players,current_players,club_id) ---
    console.log('\n♠ Tournaments');
    await up('tournaments', [
        { id: 'f1000000-0000-0000-0000-000000000001', club_id: CLUB, name: 'JAQK Sunday Major', game_type: 'NLH', buy_in_amount: 45, buy_in_fee: 5, guaranteed_prize: 1400, start_time: ago(2 * H), status: 'running', current_players: 28, max_players: 50, starting_chips: 10000, created_at: ago(3 * D) },
        { id: 'f1000000-0000-0000-0000-000000000002', club_id: CLUB, name: 'JAQK Nightly Turbo', game_type: 'NLH', buy_in_amount: 18, buy_in_fee: 2, start_time: fwd(2 * H), status: 'registering', current_players: 12, max_players: 30, starting_chips: 5000, created_at: ago(1 * D) },
        { id: 'f1000000-0000-0000-0000-000000000003', club_id: CLUB, name: 'JAQK SNG Express', game_type: 'NLH', buy_in_amount: 9, buy_in_fee: 1, start_time: ago(1 * D), status: 'completed', current_players: 9, max_players: 9, starting_chips: 3000, created_at: ago(2 * D) },
        { id: 'f1000000-0000-0000-0000-000000000004', club_id: CLUB, name: 'JAQK PLO Championship', game_type: 'PLO', buy_in_amount: 90, buy_in_fee: 10, guaranteed_prize: 2200, start_time: ago(3 * H), status: 'running', current_players: 22, max_players: 30, starting_chips: 15000, created_at: ago(5 * D) },
    ]);

    // --- HANDS (live: id,table_id,club_id,hand_number,pot,rake,community_cards,board,status) ---
    console.log('\n♠ Hands');
    await up('hands', [
        { id: 'f2000000-0000-0000-0000-000000000001', table_id: 'f0000000-0000-0000-0000-000000000002', club_id: CLUB, hand_number: 1001, pot: 42.5, rake: 2, community_cards: ['Ah', 'Kd', '7s', '2c', 'Jh'], status: 'completed', created_at: ago(30 * M) },
        { id: 'f2000000-0000-0000-0000-000000000002', table_id: 'f0000000-0000-0000-0000-000000000002', club_id: CLUB, hand_number: 1002, pot: 85, rake: 4, community_cards: ['Qs', 'Ts', '9s', '3h', '6d'], status: 'completed', created_at: ago(25 * M) },
        { id: 'f2000000-0000-0000-0000-000000000003', table_id: 'f0000000-0000-0000-0000-000000000003', club_id: CLUB, hand_number: 2001, pot: 150, rake: 7.5, community_cards: ['Kh', 'Kc', '5d', '5s', 'As'], status: 'completed', created_at: ago(20 * M) },
        { id: 'f2000000-0000-0000-0000-000000000004', table_id: 'f0000000-0000-0000-0000-000000000001', club_id: CLUB, hand_number: 501, pot: 18, rake: 0.75, community_cards: ['8h', '9h', 'Th', '2d', '4c'], status: 'completed', created_at: ago(1 * D) },
        { id: 'f2000000-0000-0000-0000-000000000005', table_id: 'f0000000-0000-0000-0000-000000000004', club_id: CLUB, hand_number: 3001, pot: 320, rake: 15, community_cards: ['Ac', 'Ad', 'Kc', 'Qd', 'Jc'], status: 'completed', created_at: ago(1 * D) },
        { id: 'f2000000-0000-0000-0000-000000000006', table_id: 'f0000000-0000-0000-0000-000000000005', club_id: CLUB, hand_number: 4001, pot: 95, rake: 4.5, community_cards: ['Jd', 'Td', '9c', '8c', '7h'], status: 'completed', created_at: ago(3 * D) },
        { id: 'f2000000-0000-0000-0000-000000000007', table_id: 'f0000000-0000-0000-0000-000000000002', club_id: CLUB, hand_number: 801, pot: 65, rake: 3, community_cards: ['5h', '5c', '5d', 'Kh', '2s'], status: 'completed', created_at: ago(7 * D) },
        { id: 'f2000000-0000-0000-0000-000000000008', table_id: 'f0000000-0000-0000-0000-000000000003', club_id: CLUB, hand_number: 1501, pot: 210, rake: 10, community_cards: ['Ah', 'Kh', 'Qh', 'Jh', '2d'], status: 'completed', created_at: ago(7 * D) },
    ]);

    // --- HORSES ---
    console.log('\n♠ Horses');
    await up('horses', [
        { id: 'f7000000-0000-0000-0000-000000000001', name: 'Hydra Alpha', skill_level: 7, play_style: 'aggressive', supported_games: ['NLH', 'PLO'], status: 'available', hands_played: 5200, total_profit: 1250 },
        { id: 'f7000000-0000-0000-0000-000000000002', name: 'Hydra Beta', skill_level: 5, play_style: 'balanced', supported_games: ['NLH'], status: 'playing', hands_played: 3100, total_profit: -420 },
        { id: 'f7000000-0000-0000-0000-000000000003', name: 'Hydra Gamma', skill_level: 8, play_style: 'tight', supported_games: ['NLH', 'PLO'], status: 'available', hands_played: 8900, total_profit: 3100 },
    ]);

    // --- NOTIFICATIONS (live: id,user_id,type,title,message,is_read,created_at) ---
    console.log('\n♠ Notifications');
    await up('notifications', [
        { id: 'ad000000-0000-0000-0000-000000000001', user_id: U(1), type: 'achievement', title: 'Achievement Unlocked!', message: "You've earned VIP Diamond status! 💎", is_read: true, created_at: ago(10 * D) },
        { id: 'ad000000-0000-0000-0000-000000000002', user_id: U(1), type: 'tournament_start', title: 'Tournament Starting!', message: 'JAQK Sunday Major begins in 5 minutes', is_read: true, created_at: ago(2 * H) },
        { id: 'ad000000-0000-0000-0000-000000000003', user_id: U(2), type: 'system', title: 'Welcome to Club JAQK', message: "You've been promoted to Admin! 🎉", is_read: true, created_at: ago(84 * D) },
        { id: 'ad000000-0000-0000-0000-000000000004', user_id: U(7), type: 'bonus', title: 'Daily Bonus Ready!', message: "Spin the wheel for today's reward", is_read: false, created_at: ago(2 * H) },
        { id: 'ad000000-0000-0000-0000-000000000005', user_id: U(9), type: 'settlement', title: 'Weekly Settlement', message: 'Your weekly results are ready', is_read: false, created_at: ago(1 * D) },
        { id: 'ad000000-0000-0000-0000-000000000006', user_id: U(6), type: 'table_ready', title: 'Seat Available!', message: 'A seat is open at JAQK Mid', is_read: true, created_at: ago(3 * H) },
        { id: 'ad000000-0000-0000-0000-000000000007', user_id: U(13), type: 'friend_request', title: 'New Friend Request', message: 'StackAttack wants to be your friend', is_read: false, created_at: ago(5 * H) },
        { id: 'ad000000-0000-0000-0000-000000000008', user_id: U(25), type: 'system', title: 'Welcome!', message: 'Welcome to Club JAQK! Start playing now 🃏', is_read: false, created_at: ago(3 * D) },
    ]);

    // --- CLUB ANNOUNCEMENTS ---
    console.log('\n♠ Announcements');
    await up('club_announcements', [
        { id: 'b2000000-0000-0000-0000-000000000001', club_id: CLUB, author_id: U(1), title: '🎉 Welcome to Club JAQK!', content: 'Welcome to our new poker club! NLH, PLO, and Short Deck.', is_pinned: true, created_at: ago(89 * D) },
        { id: 'b2000000-0000-0000-0000-000000000002', club_id: CLUB, author_id: U(1), title: '🏆 Sunday Major — Every Week', content: '$50 buy-in, $1,000 GTD. Every Sunday at 7 PM.', is_pinned: true, created_at: ago(60 * D) },
        { id: 'b2000000-0000-0000-0000-000000000003', club_id: CLUB, author_id: U(2), title: '📋 New Table Rules', content: 'All NLH tables now support Run It Twice.', is_pinned: false, created_at: ago(30 * D) },
        { id: 'b2000000-0000-0000-0000-000000000004', club_id: CLUB, author_id: U(1), title: '🎊 PLO Championship Added!', content: 'Monthly PLO Championship! $100 buy-in, 30 player max.', is_pinned: false, created_at: ago(6 * D) },
    ]);

    // --- PROMOTIONS ---
    console.log('\n♠ Promotions');
    await up('promotions', [
        { id: 'b3000000-0000-0000-0000-000000000001', club_id: CLUB, name: 'February Rake Race', description: 'Play the most hands!', type: 'rake_race', start_date: ago(15 * D), end_date: fwd(15 * D), status: 'active', prize_pool: 5000, opt_in_required: true, is_featured: true },
        { id: 'b3000000-0000-0000-0000-000000000002', club_id: CLUB, name: 'High Hand of the Week', description: 'Best hand wins!', type: 'high_hand', start_date: ago(3 * D), end_date: fwd(4 * D), status: 'active', prize_pool: 1000, is_featured: true },
        { id: 'b3000000-0000-0000-0000-000000000003', club_id: CLUB, name: 'New Member Freeroll', type: 'milestone', start_date: fwd(5 * D), end_date: fwd(5 * D + 4 * H), status: 'scheduled', prize_pool: 500, opt_in_required: true },
        { id: 'b3000000-0000-0000-0000-000000000004', club_id: CLUB, name: 'January Grinder Award', type: 'leaderboard', start_date: ago(45 * D), end_date: ago(15 * D), status: 'completed', prize_pool: 3000 },
    ]);

    // --- FRIENDSHIPS ---
    console.log('\n♠ Friendships');
    await up('friendships', [
        { id: 'af000000-0000-0000-0000-000000000001', user_id: U(1), friend_id: U(2) },
        { id: 'af000000-0000-0000-0000-000000000002', user_id: U(2), friend_id: U(1) },
        { id: 'af000000-0000-0000-0000-000000000003', user_id: U(7), friend_id: U(9) },
        { id: 'af000000-0000-0000-0000-000000000004', user_id: U(9), friend_id: U(7) },
        { id: 'af000000-0000-0000-0000-000000000005', user_id: U(3), friend_id: U(6) },
        { id: 'af000000-0000-0000-0000-000000000006', user_id: U(6), friend_id: U(3) },
        { id: 'af000000-0000-0000-0000-000000000007', user_id: U(13), friend_id: U(14) },
        { id: 'af000000-0000-0000-0000-000000000008', user_id: U(14), friend_id: U(13) },
        { id: 'af000000-0000-0000-0000-000000000009', user_id: U(1), friend_id: U(7) },
        { id: 'af000000-0000-0000-0000-000000000010', user_id: U(7), friend_id: U(1) },
    ]);

    // --- DIRECT MESSAGES ---
    console.log('\n♠ Messages');
    await up('direct_messages', [
        { id: 'ae000000-0000-0000-0000-000000000001', sender_id: U(1), recipient_id: U(2), content: 'Hey Maria, can you review the new member applications?', is_read: true, created_at: ago(2 * D) },
        { id: 'ae000000-0000-0000-0000-000000000002', sender_id: U(2), recipient_id: U(1), content: "Sure thing! I'll handle them this afternoon.", is_read: true, created_at: ago(2 * D - 15 * M) },
        { id: 'ae000000-0000-0000-0000-000000000003', sender_id: U(7), recipient_id: U(9), content: 'GG on that hand! That was a sick call.', is_read: true, created_at: ago(1 * D) },
        { id: 'ae000000-0000-0000-0000-000000000004', sender_id: U(9), recipient_id: U(7), content: 'Haha thanks, I had a read on you 😏', is_read: true, created_at: ago(1 * D - 5 * M) },
    ]);

    // --- CHIP TRANSACTIONS (live: id,club_id,from_user_id,to_user_id,amount,transaction_type,notes) ---
    console.log('\n♠ Chip Transactions');
    await up('chip_transactions', [
        { id: 'aa000000-0000-0000-0000-000000000001', club_id: CLUB, to_user_id: U(1), amount: 50000, transaction_type: 'deposit', notes: 'Initial deposit', created_at: ago(30 * D) },
        { id: 'aa000000-0000-0000-0000-000000000002', club_id: CLUB, to_user_id: U(6), amount: 10000, transaction_type: 'deposit', notes: 'Agent ref: Jake', created_at: ago(28 * D) },
        { id: 'aa000000-0000-0000-0000-000000000003', club_id: CLUB, to_user_id: U(7), amount: 20000, transaction_type: 'deposit', notes: 'Agent ref: Jake', created_at: ago(27 * D) },
        { id: 'aa000000-0000-0000-0000-000000000004', club_id: CLUB, from_user_id: U(1), amount: 15000, transaction_type: 'withdrawal', notes: 'Weekly withdrawal', created_at: ago(20 * D) },
        { id: 'aa000000-0000-0000-0000-000000000005', club_id: CLUB, to_user_id: U(25), amount: 1000, transaction_type: 'deposit', notes: 'Sign-up bonus', created_at: ago(3 * D) },
    ]);

    // --- RAKE RECORDS ---
    console.log('\n♠ Rake Records');
    await up('rake_records', [
        { id: 'cf000000-0000-0000-0000-000000000001', hand_id: 'f2000000-0000-0000-0000-000000000001', table_id: 'f0000000-0000-0000-0000-000000000002', club_id: CLUB, rake_amount: 2, bbj_contribution: 0.25, pot_size: 42.5, num_players: 6, created_at: ago(30 * M) },
        { id: 'cf000000-0000-0000-0000-000000000002', hand_id: 'f2000000-0000-0000-0000-000000000002', table_id: 'f0000000-0000-0000-0000-000000000002', club_id: CLUB, rake_amount: 4, bbj_contribution: 0.5, pot_size: 85, num_players: 7, created_at: ago(25 * M) },
        { id: 'cf000000-0000-0000-0000-000000000003', hand_id: 'f2000000-0000-0000-0000-000000000003', table_id: 'f0000000-0000-0000-0000-000000000003', club_id: CLUB, rake_amount: 7.5, bbj_contribution: 1, pot_size: 150, num_players: 5, created_at: ago(20 * M) },
        { id: 'cf000000-0000-0000-0000-000000000004', hand_id: 'f2000000-0000-0000-0000-000000000005', table_id: 'f0000000-0000-0000-0000-000000000004', club_id: CLUB, rake_amount: 15, bbj_contribution: 2, pot_size: 320, num_players: 4, created_at: ago(1 * D) },
    ]);

    // --- SETTLEMENT PERIODS ---
    console.log('\n♠ Settlements');
    await up('settlement_periods', [
        { id: 'ca000000-0000-0000-0000-000000000001', club_id: CLUB, period_number: 4, year: 2026, start_at: '2026-01-19T00:00:00Z', end_at: '2026-01-25T23:59:59Z', status: 'settled', total_rake_collected: 4250, total_hands_dealt: 2800 },
        { id: 'ca000000-0000-0000-0000-000000000002', club_id: CLUB, period_number: 5, year: 2026, start_at: '2026-01-26T00:00:00Z', end_at: '2026-02-01T23:59:59Z', status: 'settled', total_rake_collected: 5120, total_hands_dealt: 3400 },
        { id: 'ca000000-0000-0000-0000-000000000003', club_id: CLUB, period_number: 6, year: 2026, start_at: '2026-02-02T00:00:00Z', end_at: '2026-02-08T23:59:59Z', status: 'settled', total_rake_collected: 6380, total_hands_dealt: 4200 },
        { id: 'ca000000-0000-0000-0000-000000000004', club_id: CLUB, period_number: 7, year: 2026, start_at: '2026-02-09T00:00:00Z', end_at: '2026-02-15T23:59:59Z', status: 'open', total_rake_collected: 3100, total_hands_dealt: 2100 },
    ]);

    // --- CLUB FINANCIAL SUMMARY ---
    console.log('\n♠ Club Financials');
    await up('club_financial_summary', [
        { id: 'da000000-0000-0000-0000-000000000001', club_id: CLUB, period_start: ago(7 * D), period_end: ago(0), total_rake: 6380, total_rakeback: 638, agent_fees: 613.4, net_revenue: 5128.6, hands_played: 4200, active_players: 24 },
        { id: 'da000000-0000-0000-0000-000000000002', club_id: CLUB, period_start: ago(30 * D), period_end: ago(0), total_rake: 21130, total_rakeback: 2113, agent_fees: 2008, net_revenue: 17009, hands_played: 12400, active_players: 25 },
    ]);

    // --- TRAINING PROGRESS ---
    console.log('\n♠ Training Progress');
    await up('training_progress', [
        { id: 'de000000-0000-0000-0000-000000000001', user_id: U(1), game_id: 'preflop_trainer', level: 8, xp: 2400, hands_played: 450, correct_answers: 380, total_answers: 450, best_streak: 25, current_streak: 12 },
        { id: 'de000000-0000-0000-0000-000000000002', user_id: U(7), game_id: 'preflop_trainer', level: 6, xp: 1800, hands_played: 300, correct_answers: 240, total_answers: 300, best_streak: 20, current_streak: 8 },
        { id: 'de000000-0000-0000-0000-000000000003', user_id: U(10), game_id: 'preflop_trainer', level: 2, xp: 300, hands_played: 50, correct_answers: 35, total_answers: 50, best_streak: 8, current_streak: 3 },
    ], 'user_id,game_id');

    // --- VIP FEATURE USAGE ---
    console.log('\n♠ VIP Feature Usage');
    await up('vip_feature_usage', [
        { id: 'dd000000-0000-0000-0000-000000000001', user_id: U(1), feature: 'advanced_stats', usage_count: 45, daily_usage: 3, last_used_at: ago(2 * H) },
        { id: 'dd000000-0000-0000-0000-000000000002', user_id: U(1), feature: 'custom_avatar', usage_count: 5, daily_usage: 0, last_used_at: ago(5 * D) },
        { id: 'dd000000-0000-0000-0000-000000000003', user_id: U(7), feature: 'advanced_stats', usage_count: 22, daily_usage: 2, last_used_at: ago(3 * H) },
        { id: 'dd000000-0000-0000-0000-000000000004', user_id: U(9), feature: 'advanced_stats', usage_count: 38, daily_usage: 4, last_used_at: ago(6 * H) },
        { id: 'dd000000-0000-0000-0000-000000000005', user_id: U(14), feature: 'hand_replayer', usage_count: 30, daily_usage: 2, last_used_at: ago(4 * H) },
    ]);

    // --- AGENT COMMISSIONS ---
    //
    // These rows used to be written to `commission_records`, a table phase 7
    // dropped on 2026-09-01 after it had held zero rows for its entire life
    // while the app read it. The ledger every commission surface reads is
    // `agent_commissions`, keyed by (club_id, user_id) rather than agents.id,
    // with `settled_at` NULL meaning the agent has not claimed it yet. Seeding
    // the dropped table left a freshly seeded dev database with an agent
    // dashboard showing nothing.
    console.log('\n♠ Agent Commissions');
    await up('agent_commissions', [
        { id: 'b9000000-0000-0000-0000-000000000001', club_id: CLUB, user_id: U(3), amount: 30, commission_rate: 0.12, source_type: 'rake_settlement', notes: 'SuitedAce at JAQK Low', settled_at: null, created_at: ago(1 * D) },
        { id: 'b9000000-0000-0000-0000-000000000002', club_id: CLUB, user_id: U(3), amount: 70, commission_rate: 0.12, source_type: 'rake_settlement', notes: 'StackAttack at JAQK Mid', settled_at: null, created_at: ago(1 * D) },
        { id: 'b9000000-0000-0000-0000-000000000003', club_id: CLUB, user_id: U(3), amount: 144, commission_rate: 0.12, source_type: 'rake_settlement', notes: 'Aggro_ETH at JAQK High', settled_at: null, created_at: ago(1 * D) },
        { id: 'b9000000-0000-0000-0000-000000000004', club_id: CLUB, user_id: U(4), amount: 42, commission_rate: 0.10, source_type: 'rake_settlement', notes: '3BetMason at JAQK Mid', settled_at: null, created_at: ago(2 * D) },
        { id: 'b9000000-0000-0000-0000-000000000005', club_id: CLUB, user_id: U(5), amount: 30, commission_rate: 0.08, source_type: 'rake_settlement', notes: 'PLOQueen at PLO Action', settled_at: null, created_at: ago(1 * D) },
    ]);

    console.log('\n' + '═'.repeat(60));
    console.log('♠ CLUB JAQK SEED v2 COMPLETE!');
    console.log('═'.repeat(60));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) });
