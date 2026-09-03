-- ═══════════════════════════════════════════════════════════════════════════════
-- 🐴 HORSE FLEET 300 — Full Real Player Parity
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Phase 1: Fix existing 100 horses (add emails, avatars, diamond_wallets)
-- Phase 2: Create 200 NEW horses (#101-#300 in fleet, unique player_numbers)
-- Phase 3: Ensure all 300 horses have club_members in BOTH clubs
-- Phase 4: Create player_stats for all 300
-- Phase 5: Reserve player_numbers so new signups never reuse them
--
-- Created: 2026-03-11
-- ═══════════════════════════════════════════════════════════════════════════════

-- Club IDs
-- SHARK_CLUB: a41434bb-8d0c-400a-8f0d-e8b3d65afed4
-- JAQK_CLUB:  a0000000-0000-0000-0000-000000000001

-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 1: Fix Existing 100 Horses — emails, avatars, diamond_wallets
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1a. Add emails and avatar URLs to existing horses that are missing them
UPDATE profiles
SET
    email = COALESCE(email, 'horse.' || lower(replace(username, ' ', '.')) || '@hydra.smarter.poker'),
    avatar_url = COALESCE(avatar_url, 'https://api.dicebear.com/7.x/avataaars/svg?seed=' || encode(id::text::bytea, 'hex'))
WHERE is_horse = TRUE AND (email IS NULL OR avatar_url IS NULL);

-- 1b. Create diamond_wallets for horses that don't have one
INSERT INTO diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent)
SELECT p.id, 0, 0, 0
FROM profiles p
WHERE p.is_horse = TRUE
AND NOT EXISTS (SELECT 1 FROM diamond_wallets dw WHERE dw.user_id = p.id)
ON CONFLICT (user_id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 2: Create 200 New Horses
-- ═══════════════════════════════════════════════════════════════════════════════

-- Name pools for generating unique, realistic poker player names
CREATE TEMP TABLE IF NOT EXISTS new_horse_names (idx SERIAL, full_name TEXT, username TEXT);
INSERT INTO new_horse_names (full_name, username) VALUES
    -- 200 unique poker-themed names that match existing style
    ('RiverRat Rick', 'riverrat_rick'),
    ('PocketPair Pete', 'pocketpair_pete'),
    ('StraightDraw Sam', 'straightdraw_sam'),
    ('NutFlush Nate', 'nutflush_nate'),
    ('OverBet Oscar', 'overbet_oscar'),
    ('ThreeBet Tony', 'threebet_tony'),
    ('SnapCall Sara', 'snapcall_sara'),
    ('RunGood Ruby', 'rungood_ruby'),
    ('SetMiner Seth', 'setminer_seth'),
    ('WetBoard Will', 'wetboard_will'),
    ('DryBoard Dave', 'dryboard_dave'),
    ('SplitPot Steve', 'splitpot_steve'),
    ('TopPair Tina', 'toppair_tina'),
    ('SecondPair Sue', 'secondpair_sue'),
    ('BottomPair Ben', 'bottompair_ben'),
    ('OpenEnder Emma', 'openender_emma'),
    ('FlushDraw Fred', 'flushdraw_fred'),
    ('OverPair Owen', 'overpair_owen'),
    ('UnderPair Uma', 'underpair_uma'),
    ('CheckBack Chad', 'checkback_chad'),
    ('DonkBet Diana', 'donkbet_diana'),
    ('Limp Larry', 'limp_larry'),
    ('SqueezePlay', 'squeezeplay'),
    ('ColdCall Carl', 'coldcall_carl'),
    ('BlockBet Beth', 'blockbet_beth'),
    ('PotControl Pat', 'potcontrol_pat'),
    ('ThinValue Vic', 'thinvalue_vic'),
    ('MergeRange Mike', 'mergerange_mike'),
    ('PolarRange Paul', 'polarrange_paul'),
    ('LinearRange Leo', 'linearrange_leo'),
    ('BalancedBet Bob', 'balancedbet_bob'),
    ('Exploiter Eve', 'exploiter_eve'),
    ('NodeLock Nick', 'nodelock_nick'),
    ('EquityCalc Eli', 'equitycalc_eli'),
    ('RangeAdv Ray', 'rangeadv_ray'),
    ('NutAdv Nina', 'nutadv_nina'),
    ('BoardCov Britt', 'boardcov_britt'),
    ('PositionKing', 'positionking'),
    ('RelativePos Rex', 'relativepos_rex'),
    ('AbsolutePos Ava', 'absolutepos_ava'),
    ('StackDepth Stan', 'stackdepth_stan'),
    ('EffStack Ella', 'effstack_ella'),
    ('SPR Spencer', 'spr_spencer'),
    ('CBet Chris', 'cbet_chris'),
    ('XRaise Xander', 'xraise_xander'),
    ('DoubleBoard DB', 'doubleboard_db'),
    ('BombPot Bella', 'bombpot_bella'),
    ('Straddle Steve', 'straddle_steve2'),
    ('AnteUp Andy', 'anteup_andy'),
    ('PostFlop Pete', 'postflop_pete'),
    ('PreFlop Pam', 'preflop_pam'),
    ('TurnBet Tara', 'turnbet_tara'),
    ('RiverBluff Rob', 'riverbluff_rob'),
    ('ShowDown Shane', 'showdown_shane'),
    ('AllIn Ally', 'allin_ally'),
    ('JamShove Jake', 'jamshove_jake'),
    ('OpenShove Omar', 'openshove_omar'),
    ('RestealRob', 'restealrob'),
    ('StealBlind SB', 'stealblind_sb'),
    ('DefendBB Dean', 'defendbb_dean'),
    ('SBWarrior', 'sbwarrior'),
    ('BBSpecial', 'bbspecial'),
    ('UTGRock Uri', 'utgrock_uri'),
    ('UTG1Nit Nancy', 'utg1nit_nancy'),
    ('MPGrinder Mel', 'mpgrinder_mel'),
    ('HJHero Harry', 'hjhero_harry'),
    ('COKiller Kate', 'cokiller_kate'),
    ('BTNBandit Bill', 'btnbandit_bill'),
    ('SBSqueeze Sam', 'sbsqueeze_sam'),
    ('BBDefend Brenda', 'bbdefend_brenda'),
    ('MultiWay Mia', 'multiway_mia'),
    ('HeadsUpHero', 'headsuphero'),
    ('ThreeWay Theo', 'threeway_theo'),
    ('FourWay Frank', 'fourway_frank'),
    ('FullRing Flo', 'fullring_flo'),
    ('SixMax Sid', 'sixmax_sid'),
    ('ShortDeck SD', 'shortdeck_sd'),
    ('Omaha Omar', 'omaha_omar'),
    ('PLO Player', 'plo_player'),
    ('MixedMax Maya', 'mixedmax_maya'),
    ('TurboTime TT', 'turbotime_tt'),
    ('HyperTurbo HT', 'hyperturbo_ht'),
    ('DeepStack DS', 'deepstack_ds2'),
    ('ShallowStack', 'shallowstack'),
    ('BigStack Barry', 'bigstack_barry'),
    ('MedStack Mark', 'medstack_mark'),
    ('ShortStack SS', 'shortstack_ss'),
    ('ChipUp Chuck', 'chipup_chuck'),
    ('ChipDown Chloe', 'chipdown_chloe'),
    ('BreakEven BJ', 'breakeven_bj'),
    ('WinRate Will', 'winrate_will'),
    ('RakeBack Ricky', 'rakeback_ricky'),
    ('PromoPlay PP', 'promoplay_pp'),
    ('BonusHunter BH', 'bonushunter_bh'),
    ('FreeRoll Fran', 'freeroll_fran'),
    ('SatPlayer SP', 'satplayer_sp'),
    ('MainEvent ME', 'mainevent_me'),
    ('SideEvent SE', 'sideevent_se'),
    ('CashKing CK', 'cashking_ck'),
    ('TourneyPro TP', 'tourneypro_tp'),
    ('SNGMaster SM', 'sngmaster_sm'),
    ('SpinGo SG', 'spingo_sg'),
    ('JackpotSit JS', 'jackpotsit_js'),
    ('KnockOut KO', 'knockout_ko2'),
    ('BountyBuilder', 'bountybuilder'),
    ('ProgKO PKO', 'progko_pko'),
    ('FreezeOut FO', 'freezeout_fo'),
    ('RebuyKing RK', 'rebuyking_rk'),
    ('AddonAce AA', 'addonace_aa'),
    ('LateReg LR', 'latereg_lr'),
    ('BubbleBoy BB2', 'bubbleboy_bb2'),
    ('FinalTableFT', 'finaltableft'),
    ('ChipLeadCL', 'chipleadcl'),
    ('ShortChip SC', 'shortchip_sc'),
    ('AvgStack AS', 'avgstack_as'),
    ('BigBlind BB3', 'bigblind_bb3'),
    ('SmallBl SB2', 'smallbl_sb2'),
    ('Dealer DLR', 'dealer_dlr'),
    ('TableCap TC', 'tablecap_tc'),
    ('RakeHunter RH', 'rakehunter_rh'),
    ('GrinderKing GK', 'grinderking_gk'),
    ('SessionPro SP2', 'sessionpro_sp2'),
    ('VolTable VT', 'voltable_vt'),
    ('NitCorner NC', 'nitcorner_nc'),
    ('LagLife LL', 'laglife_ll'),
    ('TagTeam TT2', 'tagteam_tt2'),
    ('TrickyTom', 'trickytom'),
    ('ManiacMax', 'maniacmax'),
    ('SolidRock SR', 'solidrock_sr'),
    ('LooseGoose LG', 'loosegoose_lg'),
    ('TightFist TF', 'tightfist_tf'),
    ('AggroAndy', 'aggroandy'),
    ('PassivePete', 'passivepete'),
    ('CallingMachine', 'callingmachine'),
    ('BettingBeast', 'bettingbeast'),
    ('RaisingRita', 'raisingrita'),
    ('FoldingFiona', 'foldingfiona'),
    ('BluffKing BK', 'bluffking_bk'),
    ('ValueTown VT2', 'valuetown_vt2'),
    ('PotOdds PO', 'potodds_po'),
    ('ImpliedGuy IG', 'impliedguy_ig'),
    ('ReverseIO RIO', 'reverseio_rio'),
    ('FoldEquityFE', 'foldequityfe'),
    ('BarrelDown BD', 'barreldown_bd'),
    ('ProbePlay PP2', 'probeplay_pp2'),
    ('DelayedCB DC', 'delayedcb_dc'),
    ('FloatMaster FM', 'floatmaster_fm'),
    ('SemiBluff SBF', 'semibluff_sbf'),
    ('PureBluff PBF', 'purebluff_pbf'),
    ('ValueCut VC', 'valuecut_vc'),
    ('ThinBluff TB', 'thinbluff_tb'),
    ('OverBluff OB', 'overbluff_ob'),
    ('UnderBluff UB', 'underbluff_ub'),
    ('BalancedBF BBF', 'balancedbf_bbf'),
    ('ExploitBF EBF', 'exploitbf_ebf'),
    ('GTOPlayer GP', 'gtoplayer_gp'),
    ('NashEqui NE', 'nashequi_ne'),
    ('ICMPressure IP', 'icmpressure_ip'),
    ('ChipEV CE', 'chipev_ce'),
    ('RealMoney RM', 'realmoney_rm'),
    ('PlayMoney PM', 'playmoney_pm'),
    ('HighStakes HS', 'highstakes_hs'),
    ('MidStakes MS', 'midstakes_ms'),
    ('LowStakes LS', 'lowstakes_ls'),
    ('MicroStakes', 'microstakes'),
    ('NanoStakes NS', 'nanostakes_ns'),
    ('Pennies Penn', 'pennies_penn'),
    ('RollerHigh RH2', 'rollerhigh_rh2'),
    ('NitReg NR', 'nitreg_nr'),
    ('RecPlayer RP', 'recplayer_rp'),
    ('WeekendW WW', 'weekendw_ww'),
    ('NightOwl NO', 'nightowl_no'),
    ('EarlyBird EB', 'earlybird_eb'),
    ('PeakHours PH', 'peakhours_ph'),
    ('OffPeak OP', 'offpeak_op'),
    ('TableSelect TS', 'tableselect_ts'),
    ('SeatSelect SS2', 'seatselect_ss2'),
    ('WaitList WL', 'waitlist_wl'),
    ('AutoRebuy AR', 'autorebuy_ar'),
    ('TopUp TU', 'topup_tu'),
    ('CashOut CO', 'cashout_co'),
    ('SitOut SO', 'sitout_so'),
    ('SitIn SI', 'sitin_si'),
    ('PostBB PBB', 'postbb_pbb'),
    ('WaitBB WBB', 'waitbb_wbb'),
    ('RunItTwice R2', 'runitttwice_r2'),
    ('ShowCards SC2', 'showcards_sc2'),
    ('MuckHand MH', 'muckhand_mh'),
    ('AutoFold AF', 'autofold_af'),
    ('QuickFold QF', 'quickfold_qf'),
    ('SnapFold SF', 'snapfold_sf'),
    ('TimeBank TB2', 'timebank_tb2'),
    ('Disconnect DC2', 'disconnect_dc2'),
    ('Reconnect RC', 'reconnect_rc'),
    ('ObserverOB', 'observer_ob'),
    ('RailBird RB', 'railbird_rb'),
    ('SweatHorse SH', 'sweathorse_sh'),
    ('CoachMode CM', 'coachmode_cm'),
    ('ReviewHand RH3', 'reviewhand_rh3'),
    ('HandHistory HH', 'handhistory_hh'),
    ('StatTracker ST', 'stattracker_st'),
    ('HUDMaster HM', 'hudmaster_hm'),
    ('DataDriven DD', 'datadriven_dd'),
    ('NumbersCrunch', 'numberscrunch'),
    ('VarianceKing', 'varianceking'),
    ('SwingTrader', 'swingtrader'),
    ('DownSwing DS2', 'downswing_ds2'),
    ('UpSwing US', 'upswing_us'),
    ('BreakThrough BT', 'breakthrough_bt');

-- Profile types distribution for new horses
CREATE TEMP TABLE IF NOT EXISTS new_horse_profiles (profile TEXT, weight INTEGER);
INSERT INTO new_horse_profiles VALUES
    ('fish', 25), ('tag', 25), ('lag', 15), ('balanced', 15),
    ('tricky', 10), ('grinder', 10);

-- Generate 200 new horses
DO $$
DECLARE
    v_horse_row RECORD;
    v_profile TEXT;
    v_player_num INTEGER;
    v_horse_id UUID;
    v_avatar_seed TEXT;
    v_email TEXT;
BEGIN
    FOR v_horse_row IN (SELECT full_name, username FROM new_horse_names ORDER BY idx LIMIT 200) LOOP
        -- Generate unique player number (100000-999999 range to avoid collision with real players)
        LOOP
            v_player_num := 100000 + floor(random() * 900000)::int;
            -- Make sure it doesn't exist
            EXIT WHEN NOT EXISTS (SELECT 1 FROM profiles WHERE player_number = v_player_num);
        END LOOP;

        -- Pick a weighted random profile
        SELECT profile INTO v_profile FROM new_horse_profiles ORDER BY random() * weight DESC LIMIT 1;

        v_horse_id := gen_random_uuid();
        v_avatar_seed := replace(v_horse_row.full_name, ' ', '') || v_player_num;
        v_email := 'horse.' || lower(replace(v_horse_row.username, ' ', '.')) || '@hydra.smarter.poker';

        -- Create the profile (full real player parity)
        INSERT INTO profiles (
            id,
            username,
            display_name,
            email,
            player_number,
            avatar_url,
            role,
            is_horse,
            horse_profile,
            horse_status,
            total_xp,
            xp_total,
            diamonds,
            diamond_multiplier,
            skill_tier,
            access_tier,
            email_verified,
            phone_verified,
            is_online,
            login_streak,
            current_streak,
            longest_streak,
            memory_elo,
            card_back_preference,
            training_view_mode,
            training_sound_enabled,
            training_timer_enabled,
            sounds_enabled,
            vibrations_enabled,
            tutorial_completed,
            language,
            display_name_preference,
            is_vip,
            show_stack_bb,
            vip_level,
            training_auto_advance,
            training_hints_enabled,
            messenger_preferences,
            friend_preferences,
            reels_preferences,
            store_preferences,
            bankroll_preferences,
            poker_near_me_preferences,
            video_library_preferences,
            diamond_arena_preferences,
            trivia_preferences,
            news_preferences,
            diamond_arcade_preferences,
            memory_games_preferences,
            hub_preferences,
            created_at,
            updated_at,
            last_login,
            last_seen,
            last_active
        ) VALUES (
            v_horse_id,
            v_horse_row.username,
            v_horse_row.full_name,
            v_email,
            v_player_num,
            'https://api.dicebear.com/7.x/avataaars/svg?seed=' || v_avatar_seed,
            'user',
            TRUE,
            v_profile,
            'available',
            0,           -- total_xp
            50,          -- xp_total (matches existing horses)
            300,         -- diamonds (matches existing)
            1.0,         -- diamond_multiplier
            'Newcomer',
            'Full_Access',
            FALSE,
            FALSE,
            FALSE,
            0,
            0,
            0,
            1200,        -- memory_elo default
            'white',
            'standard',
            TRUE,
            TRUE,
            TRUE,
            TRUE,
            FALSE,
            'en',
            'full_name',
            FALSE,
            FALSE,
            'none',
            FALSE,
            TRUE,
            '{"activeStatus": true, "readReceipts": true, "messageSounds": true, "notifications": true}'::jsonb,
            '{"allowRequests": true, "showOnlineStatus": true, "friendSuggestions": true}'::jsonb,
            '{"autoplay": true, "dataSaver": false, "showCaptions": true, "soundOnScroll": true}'::jsonb,
            '{"emailReceipts": true, "promotionalEmails": false}'::jsonb,
            '{"autoSave": true, "notifications": true}'::jsonb,
            '{"geofenceAlerts": true, "locationEnabled": true, "showNewcomerFriendly": true}'::jsonb,
            '{"autoplay": true, "captions": false, "hdQuality": true}'::jsonb,
            '{"autoRebuy": false, "animations": true, "soundEffects": true}'::jsonb,
            '{"hintsEnabled": false, "soundEffects": true, "timerEnabled": true}'::jsonb,
            '{"emailDigest": false, "pushNotifications": false}'::jsonb,
            '{"hints": false, "animations": true, "soundEffects": true}'::jsonb,
            '{"showTimer": true, "visualHints": false, "soundEffects": true, "keyboardShortcuts": true}'::jsonb,
            '{}'::jsonb,
            now(),
            now(),
            now(),
            now(),
            now()
        )
        ON CONFLICT (username) DO NOTHING;

        -- Create wallets (triple wallet system)
        INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
        VALUES
            (v_horse_id, 'BUSINESS', 0, 0),
            (v_horse_id, 'PLAYER', 10000, 0),
            (v_horse_id, 'PROMO', 0, 0)
        ON CONFLICT (user_id, wallet_type) DO NOTHING;

        -- Create diamond wallet
        INSERT INTO diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent)
        VALUES (v_horse_id, 0, 0, 0)
        ON CONFLICT (user_id) DO NOTHING;

        -- Join SHARK CLUB
        INSERT INTO club_members (club_id, user_id, role, status, chip_balance, is_active, is_bot, is_prepaid, trust_score, tier)
        VALUES (
            'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
            v_horse_id,
            'member',
            'approved',
            50000,
            TRUE,
            FALSE,
            TRUE,
            50,
            'bronze'
        )
        ON CONFLICT (club_id, user_id) DO NOTHING;

        -- Join JAQK CLUB
        INSERT INTO club_members (club_id, user_id, role, status, chip_balance, is_active, is_bot, is_prepaid, trust_score, tier)
        VALUES (
            'a0000000-0000-0000-0000-000000000001',
            v_horse_id,
            'member',
            'approved',
            50000,
            TRUE,
            FALSE,
            TRUE,
            50,
            'bronze'
        )
        ON CONFLICT (club_id, user_id) DO NOTHING;

    END LOOP;

    RAISE NOTICE '✅ Created 200 new horses with full real player parity';
END $$;

-- Clean up temp tables
DROP TABLE IF EXISTS new_horse_names;
DROP TABLE IF EXISTS new_horse_profiles;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 3: Ensure ALL horses have club_members in BOTH clubs
-- ═══════════════════════════════════════════════════════════════════════════════

-- Shark Club — fill any gaps
INSERT INTO club_members (club_id, user_id, role, status, chip_balance, is_active, is_bot, is_prepaid, trust_score, tier)
SELECT
    'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
    p.id,
    'member',
    'approved',
    50000,
    TRUE,
    FALSE,
    TRUE,
    50,
    'bronze'
FROM profiles p
WHERE p.is_horse = TRUE
AND NOT EXISTS (
    SELECT 1 FROM club_members cm
    WHERE cm.user_id = p.id AND cm.club_id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
)
ON CONFLICT (club_id, user_id) DO NOTHING;

-- JAQK Club — fill any gaps
INSERT INTO club_members (club_id, user_id, role, status, chip_balance, is_active, is_bot, is_prepaid, trust_score, tier)
SELECT
    'a0000000-0000-0000-0000-000000000001',
    p.id,
    'member',
    'approved',
    50000,
    TRUE,
    FALSE,
    TRUE,
    50,
    'bronze'
FROM profiles p
WHERE p.is_horse = TRUE
AND NOT EXISTS (
    SELECT 1 FROM club_members cm
    WHERE cm.user_id = p.id AND cm.club_id = 'a0000000-0000-0000-0000-000000000001'
)
ON CONFLICT (club_id, user_id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 4: Ensure ALL horses have wallets
-- ═══════════════════════════════════════════════════════════════════════════════

-- Triple wallets for any horse missing them
INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
SELECT p.id, 'BUSINESS', 0, 0
FROM profiles p WHERE p.is_horse = TRUE
AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = p.id AND w.wallet_type = 'BUSINESS')
ON CONFLICT (user_id, wallet_type) DO NOTHING;

INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
SELECT p.id, 'PLAYER', 10000, 0
FROM profiles p WHERE p.is_horse = TRUE
AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = p.id AND w.wallet_type = 'PLAYER')
ON CONFLICT (user_id, wallet_type) DO NOTHING;

INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
SELECT p.id, 'PROMO', 0, 0
FROM profiles p WHERE p.is_horse = TRUE
AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = p.id AND w.wallet_type = 'PROMO')
ON CONFLICT (user_id, wallet_type) DO NOTHING;

-- Diamond wallets for any horse missing them
INSERT INTO diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent)
SELECT p.id, 0, 0, 0
FROM profiles p WHERE p.is_horse = TRUE
AND NOT EXISTS (SELECT 1 FROM diamond_wallets dw WHERE dw.user_id = p.id)
ON CONFLICT (user_id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 5: Reserve Horse Player Numbers
-- ═══════════════════════════════════════════════════════════════════════════════

-- Create a reserved_player_numbers table so the signup trigger can check it
CREATE TABLE IF NOT EXISTS reserved_player_numbers (
    player_number INTEGER PRIMARY KEY,
    reserved_for TEXT NOT NULL DEFAULT 'horse',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Insert all horse player numbers
INSERT INTO reserved_player_numbers (player_number, reserved_for)
SELECT player_number, 'horse'
FROM profiles
WHERE is_horse = TRUE
ON CONFLICT (player_number) DO NOTHING;

-- Update the default player_number generation to skip reserved numbers
-- Replace the existing handle_new_user function to check reserved numbers
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    v_player_num INTEGER;
    v_attempts INTEGER := 0;
BEGIN
    -- Generate a unique player number that's not reserved
    LOOP
        v_player_num := 1000 + floor(random() * 99000)::int;
        v_attempts := v_attempts + 1;

        -- Exit when we find a number that's not in profiles AND not reserved
        EXIT WHEN NOT EXISTS (SELECT 1 FROM profiles WHERE player_number = v_player_num)
              AND NOT EXISTS (SELECT 1 FROM reserved_player_numbers WHERE player_number = v_player_num);

        -- Safety valve
        IF v_attempts > 1000 THEN
            v_player_num := 100000 + floor(random() * 900000)::int;
            EXIT;
        END IF;
    END LOOP;

    -- Create profile if not exists
    INSERT INTO profiles (id, username, display_name, player_number)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'username', 'Player' || v_player_num::text),
        COALESCE(NEW.raw_user_meta_data->>'display_name', 'New Player'),
        v_player_num
    )
    ON CONFLICT (id) DO NOTHING;

    -- Create diamond wallet
    INSERT INTO diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent)
    VALUES (NEW.id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERY (run after migration)
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    v_total_horses INTEGER;
    v_with_email INTEGER;
    v_with_avatar INTEGER;
    v_with_wallets INTEGER;
    v_with_diamond_wallets INTEGER;
    v_with_shark INTEGER;
    v_with_jaqk INTEGER;
BEGIN
    SELECT count(*) INTO v_total_horses FROM profiles WHERE is_horse = TRUE;
    SELECT count(*) INTO v_with_email FROM profiles WHERE is_horse = TRUE AND email IS NOT NULL;
    SELECT count(*) INTO v_with_avatar FROM profiles WHERE is_horse = TRUE AND avatar_url IS NOT NULL;
    SELECT count(DISTINCT user_id) INTO v_with_wallets FROM wallets w JOIN profiles p ON w.user_id = p.id WHERE p.is_horse = TRUE;
    SELECT count(DISTINCT user_id) INTO v_with_diamond_wallets FROM diamond_wallets dw JOIN profiles p ON dw.user_id = p.id WHERE p.is_horse = TRUE;
    SELECT count(*) INTO v_with_shark FROM club_members cm JOIN profiles p ON cm.user_id = p.id WHERE p.is_horse = TRUE AND cm.club_id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
    SELECT count(*) INTO v_with_jaqk FROM club_members cm JOIN profiles p ON cm.user_id = p.id WHERE p.is_horse = TRUE AND cm.club_id = 'a0000000-0000-0000-0000-000000000001';

    RAISE NOTICE '🐴 HORSE FLEET STATUS:';
    RAISE NOTICE '  Total horses: %', v_total_horses;
    RAISE NOTICE '  With email: %', v_with_email;
    RAISE NOTICE '  With avatar: %', v_with_avatar;
    RAISE NOTICE '  With wallets: %', v_with_wallets;
    RAISE NOTICE '  With diamond wallets: %', v_with_diamond_wallets;
    RAISE NOTICE '  In Shark Club: %', v_with_shark;
    RAISE NOTICE '  In JAQK Club: %', v_with_jaqk;
END $$;
