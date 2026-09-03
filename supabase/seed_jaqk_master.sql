-- ═══════════════════════════════════════════════════════════════════════════════
-- ♠ CLUB JAQK — MASTER SEED RUNNER
-- ═══════════════════════════════════════════════════════════════════════════════
-- Run this file to seed ALL Club JAQK mock data.
-- It includes all 4 parts in the correct dependency order.
--
-- DATA SUMMARY:
--   • 25 user profiles (various VIP levels, XP, streaks)
--   • 1 Club (JAQK) with full settings
--   • 25 members (owner, admin, 3 agents, 17 active, 1 pending, 1 suspended, 1 new)
--   • 3 agents with player hierarchies
--   • 1 union (Aces United)
--   • 25 diamond wallets
--   • 8 poker tables (NLH micro→high, PLO×2, Short Deck, VIP nosebleed)
--   • 28+ table seats with active players
--   • 5 waitlist entries
--   • 4 tournaments (MTT running, MTT registering, SNG completed, PLO Championship)
--   • 14+ tournament players
--   • 4 Spin & Go tournaments
--   • 15 sample hands (spread over 30 days)
--   • 5 Hydra bots
--   • 13 chip transactions
--   • 10 player stats
--   • 10+ achievements awarded
--   • 12 notifications
--   • 8 direct messages
--   • 10 friendships + 3 friend requests
--   • 4 club announcements
--   • 4 promotions + 5 enrollments + 5 leaderboard entries
--   • 5 special bonuses
--   • 7 daily spins
--   • 3 player reports
--   • 8 commission records
--   • 3 credit requests
--   • 4 settlement periods + 9 agent settlements + 3 club settlements
--   • 7 player weekly snapshots
--   • 1 BBJ pool
--   • 8 rake records
--   • 3 club financial summaries
--   • 8 club transactions
--   • 6 wallet transactions
--   • 7 VIP feature usage entries
--   • 5 training progress entries
--   • 4 settlement audit log entries
--   • 8 general transactions
--
-- USAGE:
--   psql -h <host> -U <user> -d <database> -f seed_jaqk_master.sql
--   OR run each part individually in order (part1 → part2 → part3 → part4)
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

\echo '♠ Part 1: Foundation (Club, Profiles, Members, Agents, Union, Wallets)...'
\i seed_jaqk_part1_foundation.sql

\echo '♠ Part 2: Tables & Games (Tables, Seats, Tournaments, Hands, Horses)...'
\i seed_jaqk_part2_tables_games.sql

\echo '♠ Part 3: Financial & Social (Transactions, Stats, Achievements, Messages, Promos)...'
\i seed_jaqk_part3_financial_social.sql

\echo '♠ Part 4: Settlements & BBJ (Periods, Agent/Club Settlements, BBJ, Rake, VIP)...'
\i seed_jaqk_part4_settlements_bbj.sql

COMMIT;

\echo ''
\echo '═══════════════════════════════════════════════════════════════════'
\echo '♠ CLUB JAQK SEED COMPLETE!'
\echo '  → 25 users  |  8 tables  |  4 tournaments  |  30 days of data'
\echo '  → Full financial history, social features, and gamification'
\echo '═══════════════════════════════════════════════════════════════════'
