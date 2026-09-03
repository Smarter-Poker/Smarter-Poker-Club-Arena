-- ═══════════════════════════════════════════════════════════════════════════════
-- ♠ CLUB JAQK — COMPREHENSIVE MOCK DATA SEED (Part 3: Financial & Social)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Transactions, settlements, BBJ, promotions, achievements, notifications,
-- messages, friends, announcements, reports, bonuses, daily spins, commissions
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. CHIP TRANSACTIONS (deposits, withdrawals, buy-ins, cash-outs, rakeback)
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO chip_transactions (id, club_id, user_id, type, amount, balance_after, reference, approved_by, status, created_at) VALUES
-- Week 1 (30 days ago)
('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', 'deposit',    50000, 50000,  'Initial deposit', '11111111-1111-1111-1111-111111111101', 'completed', NOW() - INTERVAL '30 days'),
('aa000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111106', 'deposit',    10000, 10000,  'Agent ref: Jake', '11111111-1111-1111-1111-111111111103', 'completed', NOW() - INTERVAL '28 days'),
('aa000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111107', 'deposit',    20000, 20000,  'Agent ref: Jake', '11111111-1111-1111-1111-111111111103', 'completed', NOW() - INTERVAL '27 days'),
-- Week 2
('aa000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111109', 'deposit',    30000, 30000,  'Agent ref: Jake', '11111111-1111-1111-1111-111111111103', 'completed', NOW() - INTERVAL '21 days'),
('aa000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', 'withdrawal', -15000, 235000, 'Weekly withdrawal', '11111111-1111-1111-1111-111111111101', 'completed', NOW() - INTERVAL '20 days'),
('aa000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111114', 'deposit',    15000, 15000, 'Agent ref: Liam', '11111111-1111-1111-1111-111111111105', 'completed', NOW() - INTERVAL '19 days'),
-- Week 3
('aa000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111107', 'deposit',    10000, 68000,  'Reload',          '11111111-1111-1111-1111-111111111103', 'completed', NOW() - INTERVAL '14 days'),
('aa000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111113', 'deposit',    25000, 72000,  'Agent ref: Sophia','11111111-1111-1111-1111-111111111104', 'completed', NOW() - INTERVAL '12 days'),
('aa000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111112', 'rakeback',   450,   35450,  'Weekly rakeback',  NULL, 'completed', NOW() - INTERVAL '10 days'),
-- Week 4
('aa000000-0000-0000-0000-000000000010', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111109', 'withdrawal', -20000, 71000,  'Cash out', '11111111-1111-1111-1111-111111111101', 'completed', NOW() - INTERVAL '5 days'),
('aa000000-0000-0000-0000-000000000011', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111118', 'deposit',    5000,   29000,  'Direct deposit',   NULL, 'completed', NOW() - INTERVAL '3 days'),
('aa000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111125', 'deposit',    1000,   1000,   'Sign-up bonus',    NULL, 'completed', NOW() - INTERVAL '3 days'),
-- Pending
('aa000000-0000-0000-0000-000000000013', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111120', 'deposit',    5000,   0,      'Pending approval', NULL, 'pending', NOW() - INTERVAL '1 hour')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. PLAYER STATS (25 users)
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO player_stats (id, user_id, total_hands, hands_won, showdowns_won, showdowns_total, vpip, pfr, aggression_factor, bb_per_100, total_profit, biggest_pot_won, biggest_pot_lost, hours_played) VALUES
('ab000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', 15200, 4560, 2100, 3800, 0.28, 0.22, 2.80, 6.20,  18500.00,  850.00,  420.00,  320.5),
('ab000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111102', 8900,  2450, 1200, 2200, 0.24, 0.18, 2.10, 4.10,  9200.00,   620.00,  310.00,  185.0),
('ab000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111103', 12400, 3720, 1800, 3100, 0.32, 0.26, 3.40, 3.50,  12100.00,  1200.00, 680.00,  260.0),
('ab000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111107', 7800,  2730, 1400, 2400, 0.35, 0.28, 3.80, 7.30,  15200.00,  920.00,  450.00,  162.5),
('ab000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111109', 11500, 3220, 1500, 2800, 0.42, 0.35, 4.20, -2.10, -8500.00,  1500.00, 1200.00, 240.0),
('ab000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111114', 6900,  2280, 1100, 1900, 0.38, 0.30, 3.10, 8.20,  11800.00,  780.00,  520.00,  143.8),
('ab000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111113', 8200,  2870, 1300, 2300, 0.30, 0.25, 2.90, 5.50,  9500.00,   680.00,  380.00,  170.8),
('ab000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111110', 2200,  550,  250,  500,  0.18, 0.12, 1.40, 0.50,  220.00,    85.00,   65.00,   45.8),
('ab000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 3800,  760,  350,  720,  0.22, 0.14, 1.60, -4.20, -3200.00,  180.00,  250.00,  79.2),
('ab000000-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111108', 6200, 1860, 900,  1650, 0.26, 0.20, 2.20, 3.90,  5200.00,   420.00,  280.00,  129.2)
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. ACHIEVEMENTS + USER ACHIEVEMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

-- User achievements (referencing pre-seeded achievements from 013_missing_tables.sql)
INSERT INTO user_achievements (id, user_id, achievement_id, progress, unlocked_at) VALUES
-- Tony (Diamond VIP) — all achievements
('ac000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', (SELECT id FROM achievements WHERE name = 'First Hand' LIMIT 1), 1, NOW() - INTERVAL '89 days'),
('ac000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111101', (SELECT id FROM achievements WHERE name = 'High Roller' LIMIT 1), 1, NOW() - INTERVAL '60 days'),
('ac000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111101', (SELECT id FROM achievements WHERE name = 'Table Captain' LIMIT 1), 10, NOW() - INTERVAL '45 days'),
('ac000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111101', (SELECT id FROM achievements WHERE name = 'Tournament Victor' LIMIT 1), 1, NOW() - INTERVAL '30 days'),
('ac000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111101', (SELECT id FROM achievements WHERE name = 'Regular' LIMIT 1), 7, NOW() - INTERVAL '20 days'),
('ac000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111101', (SELECT id FROM achievements WHERE name = 'VIP Diamond' LIMIT 1), 1, NOW() - INTERVAL '10 days'),
-- Noah (active grinder) — several achievements
('ac000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111107', (SELECT id FROM achievements WHERE name = 'First Hand' LIMIT 1), 1, NOW() - INTERVAL '54 days'),
('ac000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111107', (SELECT id FROM achievements WHERE name = 'High Roller' LIMIT 1), 1, NOW() - INTERVAL '30 days'),
('ac000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111107', (SELECT id FROM achievements WHERE name = 'Regular' LIMIT 1), 7, NOW() - INTERVAL '14 days'),
-- Max (brand new) — first hand only (in progress)
('ac000000-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111125', (SELECT id FROM achievements WHERE name = 'First Hand' LIMIT 1), 0, NULL),
-- Ethan (high volume) — several
('ac000000-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111109', (SELECT id FROM achievements WHERE name = 'First Hand' LIMIT 1), 1, NOW() - INTERVAL '44 days'),
('ac000000-0000-0000-0000-000000000012', '11111111-1111-1111-1111-111111111109', (SELECT id FROM achievements WHERE name = 'High Roller' LIMIT 1), 1, NOW() - INTERVAL '20 days'),
('ac000000-0000-0000-0000-000000000013', '11111111-1111-1111-1111-111111111109', (SELECT id FROM achievements WHERE name = 'VIP Gold' LIMIT 1), 1, NOW() - INTERVAL '15 days')
ON CONFLICT (user_id, achievement_id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. NOTIFICATIONS (20 sample notifications across users)
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO notifications (id, user_id, type, title, message, is_read, action_url, created_at) VALUES
('ad000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', 'achievement', 'Achievement Unlocked!', 'You''ve earned VIP Diamond status! 💎', true, '/profile', NOW() - INTERVAL '10 days'),
('ad000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111101', 'tournament_start', 'Tournament Starting!', 'JAQK Sunday Major begins in 5 minutes', true, '/tournaments', NOW() - INTERVAL '2 hours'),
('ad000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111102', 'system', 'Welcome to Club JAQK', 'You''ve been promoted to Admin! 🎉', true, '/club', NOW() - INTERVAL '84 days'),
('ad000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111107', 'bonus', 'Daily Bonus Ready!', 'Spin the wheel for today''s reward', false, '/daily-bonus', NOW() - INTERVAL '2 hours'),
('ad000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111109', 'settlement', 'Weekly Settlement', 'Your weekly results are ready to view', false, '/financials', NOW() - INTERVAL '1 day'),
('ad000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111106', 'table_ready', 'Seat Available!', 'A seat is open at JAQK Mid table', true, '/tables', NOW() - INTERVAL '3 hours'),
('ad000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111113', 'friend_request', 'New Friend Request', 'StackAttack wants to be your friend', false, '/friends', NOW() - INTERVAL '5 hours'),
('ad000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111114', 'club_invite', 'Tournament Invite', 'You''re invited to the PLO Championship!', true, '/tournaments', NOW() - INTERVAL '5 days'),
('ad000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111103', 'settlement', 'Agent Commission', 'Your weekly commission of 1,240 has been credited', true, '/agent/dashboard', NOW() - INTERVAL '7 days'),
('ad000000-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111125', 'system', 'Welcome!', 'Welcome to Club JAQK! Start playing now 🃏', false, '/lobby', NOW() - INTERVAL '3 days'),
('ad000000-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111118', 'achievement', 'Achievement Unlocked!', 'Regular — 7 day login streak! 🔥', true, '/profile', NOW() - INTERVAL '1 day'),
('ad000000-0000-0000-0000-000000000012', '11111111-1111-1111-1111-111111111120', 'message', 'New Message', 'You have a new message from QueenBee', false, '/messages', NOW() - INTERVAL '12 hours')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. DIRECT MESSAGES (conversations between users)
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO direct_messages (id, sender_id, recipient_id, content, is_read, created_at) VALUES
('ae000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111102', 'Hey Maria, can you review the new member applications?', true, NOW() - INTERVAL '2 days'),
('ae000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111102', '11111111-1111-1111-1111-111111111101', 'Sure thing! I''ll handle them this afternoon.', true, NOW() - INTERVAL '2 days' + INTERVAL '15 min'),
('ae000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111103', '11111111-1111-1111-1111-111111111106', 'Welcome to the club! Let me know if you need anything.', true, NOW() - INTERVAL '59 days'),
('ae000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111106', '11111111-1111-1111-1111-111111111103', 'Thanks Jake! Excited to play here.', true, NOW() - INTERVAL '59 days' + INTERVAL '30 min'),
('ae000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111107', '11111111-1111-1111-1111-111111111109', 'GG on that hand! That was a sick call.', true, NOW() - INTERVAL '1 day'),
('ae000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111109', '11111111-1111-1111-1111-111111111107', 'Haha thanks, I had a read on you 😏', true, NOW() - INTERVAL '1 day' + INTERVAL '5 min'),
('ae000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111102', '11111111-1111-1111-1111-111111111120', 'Hi Ella, how are you finding the club so far?', false, NOW() - INTERVAL '12 hours'),
('ae000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111104', '11111111-1111-1111-1111-111111111113', 'Don''t forget the PLO Championship starts tomorrow!', true, NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. FRIENDSHIPS & FRIEND REQUESTS
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO friendships (id, user_id, friend_id) VALUES
('af000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111102'),
('af000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111102', '11111111-1111-1111-1111-111111111101'),
('af000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111107', '11111111-1111-1111-1111-111111111109'),
('af000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111109', '11111111-1111-1111-1111-111111111107'),
('af000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111103', '11111111-1111-1111-1111-111111111106'),
('af000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111106', '11111111-1111-1111-1111-111111111103'),
('af000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111113', '11111111-1111-1111-1111-111111111114'),
('af000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111114', '11111111-1111-1111-1111-111111111113'),
('af000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111107'),
('af000000-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111107', '11111111-1111-1111-1111-111111111101')
ON CONFLICT (user_id, friend_id) DO NOTHING;

INSERT INTO friend_requests (id, sender_id, recipient_id, status, created_at) VALUES
('af100000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111107', '11111111-1111-1111-1111-111111111113', 'pending', NOW() - INTERVAL '5 hours'),
('af100000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111120', '11111111-1111-1111-1111-111111111118', 'pending', NOW() - INTERVAL '8 hours'),
('af100000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111109', 'accepted', NOW() - INTERVAL '30 days')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. CLUB ANNOUNCEMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO club_announcements (id, club_id, author_id, title, content, is_pinned, created_at) VALUES
('b2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', '🎉 Welcome to Club JAQK!', 'Welcome to our new poker club! We offer NLH, PLO, and Short Deck tables with stakes from micro to high.', true, NOW() - INTERVAL '89 days'),
('b2000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', '🏆 Sunday Major — Every Week', 'Our flagship tournament runs every Sunday at 7 PM. $50 buy-in, $1,000 GTD. See you there!', true, NOW() - INTERVAL '60 days'),
('b2000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111102', '📋 New Table Rules', 'All NLH tables now support Run It Twice. Straddle available on 0.50/1.00 and above. Bomb pots on 1/2+.', false, NOW() - INTERVAL '30 days'),
('b2000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', '🎊 New PLO Championship Added!', 'By popular demand, we''re launching a monthly PLO Championship! $100 buy-in, 30 player max.', false, NOW() - INTERVAL '6 days')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. PROMOTIONS + ENROLLMENTS + LEADERBOARDS
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO promotions (id, club_id, name, description, type, start_date, end_date, status, prize_pool, opt_in_required, is_featured) VALUES
('b3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'February Rake Race',     'Play the most hands and win prizes!',       'rake_race',   NOW() - INTERVAL '15 days', NOW() + INTERVAL '15 days', 'active',    5000.00, true,  true),
('b3000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'High Hand of the Week',  'Best hand each week wins the pot!',         'high_hand',   NOW() - INTERVAL '3 days',  NOW() + INTERVAL '4 days',  'active',    1000.00, false, true),
('b3000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'New Member Freeroll',    'Free tournament for members who joined this month', 'milestone', NOW() + INTERVAL '5 days', NOW() + INTERVAL '5 days' + INTERVAL '4 hours', 'scheduled', 500.00, true, false),
('b3000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'January Grinder Award', 'Most hands played in January wins!',        'leaderboard', NOW() - INTERVAL '45 days', NOW() - INTERVAL '15 days', 'completed', 3000.00, false, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO promotion_enrollments (id, user_id, promotion_id, status) VALUES
('b4000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', 'b3000000-0000-0000-0000-000000000001', 'active'),
('b4000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111107', 'b3000000-0000-0000-0000-000000000001', 'active'),
('b4000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111109', 'b3000000-0000-0000-0000-000000000001', 'active'),
('b4000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111113', 'b3000000-0000-0000-0000-000000000001', 'active'),
('b4000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111103', 'b3000000-0000-0000-0000-000000000001', 'active')
ON CONFLICT (user_id, promotion_id) DO NOTHING;

INSERT INTO promotion_leaderboards (id, promotion_id, user_id, score, rank, hands_played) VALUES
('b5000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111109', 2850.00, 1, 1150),
('b5000000-0000-0000-0000-000000000002', 'b3000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', 2420.00, 2, 980),
('b5000000-0000-0000-0000-000000000003', 'b3000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111103', 2100.00, 3, 850),
('b5000000-0000-0000-0000-000000000004', 'b3000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111107', 1980.00, 4, 790),
('b5000000-0000-0000-0000-000000000005', 'b3000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111113', 1650.00, 5, 680)
ON CONFLICT (promotion_id, user_id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. SPECIAL BONUSES
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO special_bonuses (id, user_id, title, description, reward, bonus_type, expires_at, claimed, claimed_at) VALUES
('b6000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', 'Loyalty Bonus', 'Thank you for 90 days with us!', '500 diamonds', 'loyalty', NOW() + INTERVAL '7 days', false, NULL),
('b6000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111107', '7-Day Streak!', 'Perfect login streak reward', '200 diamonds', 'streak', NOW() + INTERVAL '3 days', false, NULL),
('b6000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111125', 'Welcome Bonus', 'New member bonus — start playing!', '1000 chips', 'welcome', NOW() + INTERVAL '14 days', false, NULL),
('b6000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111109', 'High Roller Reward', 'For playing 10,000+ hands', '1000 diamonds', 'milestone', NOW() - INTERVAL '2 days', true, NOW() - INTERVAL '2 days'),
('b6000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111113', 'Referral Bonus', 'For bringing a new player', '300 diamonds', 'referral', NOW() + INTERVAL '5 days', false, NULL)
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. DAILY SPINS
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO daily_spins (id, user_id, reward_type, reward_amount, created_at) VALUES
('b7000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111101', 'chips',    500,  NOW() - INTERVAL '1 day'),
('b7000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111101', 'diamonds', 50,   NOW() - INTERVAL '2 days'),
('b7000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111107', 'xp',       100,  NOW() - INTERVAL '1 day'),
('b7000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111109', 'chips',    1000, NOW() - INTERVAL '1 day'),
('b7000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111106', 'diamonds', 25,   NOW() - INTERVAL '2 days'),
('b7000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111113', 'chips',    250,  NOW() - INTERVAL '1 day'),
('b7000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111118', 'xp',       200,  NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. PLAYER REPORTS
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO player_reports (id, reporter_id, reported_player_id, reason, description, status, created_at) VALUES
('b8000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111108', '11111111-1111-1111-1111-111111111124', 'Suspected collusion', 'Player ChloeCalls was sharing hand info with another player at the table.', 'resolved', NOW() - INTERVAL '8 days'),
('b8000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111112', '11111111-1111-1111-1111-111111111111', 'Abusive chat', 'RiverRat was using offensive language after losing a pot.', 'reviewing', NOW() - INTERVAL '3 days'),
('b8000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111106', '11111111-1111-1111-1111-111111111120', 'Slow play / stalling', 'EllaBluffs taking max time every action at micro stakes.', 'pending', NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. AGENT COMMISSIONS (agent earnings)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- These rows used to be written to `commission_records`, dropped by phase 7 on
-- 2026-09-01 after holding zero rows for its entire life while the app read it.
-- The ledger every commission surface reads is `agent_commissions`, keyed by
-- (club_id, user_id) rather than agents.id. `settled_at IS NULL` is what the
-- Records tab renders as Unclaimed and what fn_agent_claim_commission pays out.
-- The agent ids these rows used map to users: d0..01 -> ..103 (Jake),
-- d0..02 -> ..104 (Sophia), d0..03 -> ..105 (Liam), all in club a0..01.

INSERT INTO agent_commissions (id, club_id, user_id, amount, commission_rate, source_type, notes, settled_at, created_at) VALUES
-- Agent Jake's commissions
('b9000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111103', 30,  0.12, 'rake_settlement', 'SuitedAce at JAQK Low',    NULL, NOW() - INTERVAL '1 day'),
('b9000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111103', 70,  0.12, 'rake_settlement', 'StackAttack at JAQK Mid',  NULL, NOW() - INTERVAL '1 day'),
('b9000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111103', 144, 0.12, 'rake_settlement', 'Aggro_ETH at JAQK High',   NULL, NOW() - INTERVAL '1 day'),
('b9000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111103', 38,  0.12, 'rake_settlement', 'PotControl at JAQK Low',   NULL, NOW() - INTERVAL '3 days'),
-- Agent Sophia's commissions
('b9000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111104', 5,   0.10, 'rake_settlement', 'MicroGrind at JAQK Micro', NULL, NOW() - INTERVAL '2 days'),
('b9000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111104', 42,  0.10, 'rake_settlement', '3BetMason at JAQK Mid',    NULL, NOW() - INTERVAL '2 days'),
-- Agent Liam's commissions
('b9000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111105', 30,  0.08, 'rake_settlement', 'PLOQueen at PLO Action',   NULL, NOW() - INTERVAL '1 day'),
('b9000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111105', 17,  0.08, 'rake_settlement', 'BombPotBen at PLO Action', NULL, NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 13. CREDIT REQUESTS
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO credit_requests (id, requester_id, approver_id, club_id, requested_amount, approved_amount, reason, status, created_at) VALUES
('ba000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111106', '11111111-1111-1111-1111-111111111103', 'a0000000-0000-0000-0000-000000000001', 5000.00, 5000.00, 'Need chips for weekend session', 'approved', NOW() - INTERVAL '10 days'),
('ba000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111104', 'a0000000-0000-0000-0000-000000000001', 10000.00, NULL, 'Looking to move up stakes', 'pending', NOW() - INTERVAL '1 day'),
('ba000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111120', '11111111-1111-1111-1111-111111111101', 'a0000000-0000-0000-0000-000000000001', 3000.00, NULL, 'First time credit request', 'denied', NOW() - INTERVAL '5 days')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- END OF PART 3
-- ═══════════════════════════════════════════════════════════════════════════════
