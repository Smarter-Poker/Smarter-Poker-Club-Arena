-- THE DATABASE SPEAKS IN TITLE CASE, AND WITHOUT EMOJI
--
-- Dan 2026-08-21 and again 2026-08-31: "the first letter of every word on
-- every single page and sub page is capitalized."
-- design-guidelines.md rule 1: "NO EMOJIS - EVER."
--
-- 20260831202752 took the banned DASH characters out of this database and
-- deliberately left the casing alone, saying why: Title casing changes WORDS,
-- and a blind transform would mangle the identifiers and % placeholders these
-- messages carry. check-title-case.mjs is AST-aware for exactly that reason.
--
-- This is that promised second pass, done the only safe way: an explicit
-- old -> new map, one line per string, every word chosen by hand. No algorithm
-- touches this copy. Machine codes are deliberately NOT in the map -
-- 'NOT_HOST_OR_ADMIN', 'NEW_ACCOUNT_COOLDOWN', 'DAILY_GIFT_CAP_EXCEEDED' and
-- their kind are switch keys the client matches on, not prose, and Title
-- Casing them would break the branch that reads them.
--
-- Every string below is copy a player reads: a signup validation message, a
-- tournament rebuy refusal, a cashout note, a referral reward line, a host's
-- to-do list. Four also carried an emoji mid-sentence ("capped at 500 [gem] /
-- 24h"), which check-no-emoji.mjs bans and cannot see here - the same blind
-- spot as the dash, in a second costume. Those become the word.
--
-- SELECTED BY CONTENT, NOT BY NAME. The first attempt listed the eleven
-- functions somebody had traced, and the post-check caught a twelfth:
-- fn_mint_club_chips_zd3core, a differently-named sibling holding the same
-- union refusal. It rolled the whole thing back, which is the post-check
-- doing its job and the reason it is written as an assertion rather than a
-- report. Any function whose body contains a mapped string is rewritten, so a
-- variant nobody knew about cannot be missed.
--
-- Idempotent. FAILS if any old string survives.

SET LOCAL statement_timeout = '600s';
SET LOCAL lock_timeout = '15s';

DO $retitle$
DECLARE
  m text[][] := ARRAY[
    -- signup and profile, the first copy a new player ever reads
    ['Username must be 3-20 characters using letters, numbers, underscores, or periods (no spaces or special characters).',
     'Username Must Be 3-20 Characters Using Letters, Numbers, Underscores, Or Periods (No Spaces Or Special Characters).'],
    ['Username must be 3-20 characters using letters, numbers, underscores, or periods.',
     'Username Must Be 3-20 Characters Using Letters, Numbers, Underscores, Or Periods.'],
    ['That username is reserved. Pick a different one.',
     'That Username Is Reserved. Pick A Different One.'],
    ['That username is already taken. Pick a different one.',
     'That Username Is Already Taken. Pick A Different One.'],
    ['That username is already taken.',
     'That Username Is Already Taken.'],
    ['That username was just claimed by someone else. Pick another.',
     'That Username Was Just Claimed By Someone Else. Pick Another.'],
    ['Please enter your full name (2-80 characters).',
     'Please Enter Your Full Name (2-80 Characters).'],
    ['Phone number is required.',
     'Phone Number Is Required.'],
    ['Enter a valid phone number (7-15 digits).',
     'Enter A Valid Phone Number (7-15 Digits).'],
    ['Your profile row is missing - refresh and try again.',
     'Your Profile Row Is Missing - Refresh And Try Again.'],
    ['Cannot mark profile complete without a full name.',
     'Cannot Mark Profile Complete Without A Full Name.'],
    ['Cannot mark profile complete without a username.',
     'Cannot Mark Profile Complete Without A Username.'],
    ['Cannot mark profile complete without a valid phone number (7-15 digits).',
     'Cannot Mark Profile Complete Without A Valid Phone Number (7-15 Digits).'],
    -- money the player is told about
    ['Cashout not found or already processed',
     'Cashout Not Found Or Already Processed'],
    ['Cashout cancelled - chips returned',
     'Cashout Cancelled - Chips Returned'],
    ['Referral reward - new player joined with your code',
     'Referral Reward - New Player Joined With Your Code'],
    ['Tournament canceled - escrow refund',
     'Tournament Canceled - Escrow Refund'],
    -- the tournament rebuy path, which refuses to charge
    ['Finishing place already paid - a rebuy cannot resurrect a settled result',
     'Finishing Place Already Paid - A Rebuy Cannot Resurrect A Settled Result'],
    ['No live seat for this % - refusing to charge for chips that would be overwritten by the seat sync',
     'No Live Seat For This % - Refusing To Charge For Chips That Would Be Overwritten By The Seat Sync'],
    ['Seat disappeared during % - aborting so no charge is made',
     'Seat Disappeared During % - Aborting So No Charge Is Made'],
    ['Chip grant did not land: % expected stack % (% + %), seat % holds % - aborting so no charge is made',
     'Chip Grant Did Not Land: % Expected Stack % (% + %), Seat % Holds % - Aborting So No Charge Is Made'],
    -- club and union refusals a host reads
    ['Chip Mint is revoked for clubs in a union - chips are minted in the union and sent to the club. Ask your union owner.',
     'Chip Mint Is Revoked For Clubs In A Union - Chips Are Minted In The Union And Sent To The Club. Ask Your Union Owner.'],
    ['This club is in a union - chips are minted in the union and sent to the club, never minted in the club.',
     'This Club Is In A Union - Chips Are Minted In The Union And Sent To The Club, Never Minted In The Club.'],
    -- the gifting caps: Title Case AND the emoji comes out
    ['Fresh-paid users are capped at %s 💎 / 24h for the first 7 days after purchase',
     'Fresh-Paid Users Are Capped At %s Diamonds / 24h For The First 7 Days After Purchase'],
    ['Pair limit hit (%s 💎 / 24h to this user)',
     'Pair Limit Hit (%s Diamonds / 24h To This User)'],
    ['Daily limit hit (%s 💎 / 24h)',
     'Daily Limit Hit (%s Diamonds / 24h)'],
    ['Slow down - %s 💎 in 60s is too fast',
     'Slow Down - %s Diamonds In 60s Is Too Fast'],
    ['Cannot send to self',
     'Cannot Send To Self'],
    ['You are banned from this broadcaster',
     'You Are Banned From This Broadcaster'],
    ['Invalid arguments',
     'Invalid Arguments'],
    -- the host's to-do list
    ['Schedule your next game',
     'Schedule Your Next Game'],
    ['Add a game within the next 2 weeks (next is ',
     'Add A Game Within The Next 2 Weeks (Next Is '],
    [' days out)',
     ' Days Out)'],
    ['Upload a group logo/photo',
     'Upload A Group Logo/Photo'],
    ['Share a group post - it''s been a while',
     'Share A Group Post - It''s Been A While'],
    ['Write a fuller group description',
     'Write A Fuller Group Description'],
    ['Share your group link to drive discovery',
     'Share Your Group Link To Drive Discovery']
  ];
  r      record;
  v_def  text;
  v_new  text;
  v_ok   int := 0;
  v_i    int;
  v_left text := '';
BEGIN
  FOR r IN
    SELECT DISTINCT p.oid, p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND EXISTS (
        SELECT 1 FROM generate_subscripts(m, 1) AS i
        WHERE position(m[i][1] in p.prosrc) > 0
      )
    ORDER BY 2
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := v_def;
    FOR v_i IN 1 .. array_length(m, 1) LOOP
      v_new := replace(v_new, m[v_i][1], m[v_i][2]);
    END LOOP;
    IF v_new <> v_def THEN
      EXECUTE v_new;
      v_ok := v_ok + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'title case pass: % function(s) rewritten', v_ok;

  FOR v_i IN 1 .. array_length(m, 1) LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'
        AND position(m[v_i][1] in p.prosrc) > 0
    ) THEN
      v_left := v_left || E'\n  ' || left(m[v_i][1], 90);
    END IF;
  END LOOP;
  IF v_left <> '' THEN
    RAISE EXCEPTION 'title case pass: these old strings survived:%', v_left;
  END IF;
END
$retitle$;