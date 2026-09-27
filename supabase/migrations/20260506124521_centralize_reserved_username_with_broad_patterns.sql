-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506124521 "centralize_reserved_username_with_broad_patterns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 07dfb086233e4c7c3c3528fae4d249bb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- CENTRALIZED RESERVED-USERNAME CHECK
-- ─────────────────────────────────────────────────────────────────────────
-- Single source of truth for all reserved-username logic. Any path that
-- creates or updates profiles.username calls this. Combines:
--   1. Exact match against a curated list
--   2. Regex patterns for brand impersonation prefixes/suffixes
--
-- Updates downstream:
--   - check_username_available (legacy, used by signup form)
--   - check_username_with_suggestions (used by gate modal)
--   - claim_social_profile (used by gate submit)
--   - handle_new_user trigger (auto-creates profile on auth signup)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.is_reserved_username(p_username text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v text;
  v_exact text[] := ARRAY[
    -- System / admin
    'admin','administrator','root','sudo','superuser','system','sys','default',
    'staff','owner','mod','moderator','manager','team','official','officials',
    'verified','certified','authentic','authorized','employee','employees',
    'founder','ceo','cto','cfo','coo','exec','executive',
    -- Support / contact
    'support','helpdesk','helpcenter','helpcentre','help','helpme','helpus',
    'contact','contactus','contact_us','info','inquiry','hello','hi',
    'customerservice','customer_service','customersupport','customer_support',
    'cs','csr','faq','feedback','report','abuse',
    -- Brand: Smarter.Poker
    'smarter','smarterpoker','smartpoker','smarter_poker','smarter.poker',
    'smarter_pkr','smarterpkr','smarter_official','smarterofficial',
    'smarter_support','smarter_team','smarter_admin','smarter_help',
    'smarter_staff','smarter_mod','smarterpoker_official','smarterpoker_team',
    'smarterpoker_support','smarterpoker_admin','smarterpoker_help',
    'sp_official','sp_support','sp_admin','sp_team',
    -- Sub-products
    'jarvis','geeves','pokerbrain','poker_brain','clubarena','club_arena',
    'clubcommander','club_commander','clubcomm','pokernearme','poker_near_me',
    -- Founder / known accounts
    'kingfish','danbekavac','dan_bekavac','dan.bekavac','bekavac','dbekavac',
    -- Generic AI / bots
    'bot','robot','ai','gpt','chatgpt','claude','openai','anthropic',
    -- Web / dev infra
    'api','apis','www','web','app','apps','mobile','http','https','ftp',
    'dev','prod','staging','localhost','test','testing','demo','example',
    'sample','samples',
    -- Auth / security
    'password','passwd','login','signup','signin','signout','logout',
    'register','security','auth','authentication','oauth','sso','session',
    'token','mfa','2fa','otp','verify','verification',
    -- Communication
    'email','mail','postmaster','webmaster','hostmaster','noreply','no_reply',
    'mailer','mailerdaemon','newsletter',
    -- Money / finance
    'money','cash','bank','banking','wallet','treasury','payment','payments',
    'billing','invoice','stripe','paypal','venmo','cashapp','zelle','square',
    'applepay','googlepay','plaid',
    -- Poker terms
    'poker','dealer','tournament','tournaments','cashier','casino','casinos',
    'vip','vips','premium','pro','pros','gold','silver','platinum',
    'diamond','diamonds','chip','chips','table','tables','lobby',
    -- Competitor / impersonation
    'pokerstars','ggpoker','partypoker','888poker','americascardroom','acr',
    'wsop','worldseries','pokerbros','clubgg','pokerrrr','suprema','pokerdom',
    'naturalpoker','x-poker','xpoker',
    -- Scam / spam
    'free','freemoney','free_money','winner','winners','prize','jackpot',
    'lottery','claim','claimnow','claim_now','urgent','alert','warning',
    'notice','security_alert','account_locked','password_reset','verify_now',
    -- Generic placeholders
    'null','undefined','nil','none','void','anonymous','anon','guest','user',
    'users','everyone','all','nobody','somebody','default','me','you','i',
    -- Edge cases
    'dot','period','underscore','hyphen','space','tab'
  ];
BEGIN
  v := lower(trim(both ' @' from coalesce(p_username, '')));
  IF v IS NULL OR v = '' THEN RETURN true; END IF;

  -- Exact-match
  IF v = ANY(v_exact) THEN RETURN true; END IF;

  -- Prefix patterns — brand impersonation
  IF v ~ '^smarter[._]'      THEN RETURN true; END IF;  -- smarter_X, smarter.X
  IF v ~ '^smarterpoker'     THEN RETURN true; END IF;  -- anything starting with smarterpoker
  IF v ~ '^smartpoker'       THEN RETURN true; END IF;
  IF v ~ '^smarterpkr'       THEN RETURN true; END IF;
  IF v ~ '^jarvis[._0-9]'    THEN RETURN true; END IF;
  IF v ~ '^geeves[._0-9]'    THEN RETURN true; END IF;
  IF v ~ '^kingfish'         THEN RETURN true; END IF;  -- kingfish*, no impersonation of Dan
  IF v ~ '^bekavac'          THEN RETURN true; END IF;
  IF v ~ '^danbekavac'       THEN RETURN true; END IF;
  IF v ~ '^pokerbrain'       THEN RETURN true; END IF;
  IF v ~ '^clubarena'        THEN RETURN true; END IF;
  IF v ~ '^clubcommander'    THEN RETURN true; END IF;

  -- Prefix patterns — system role impersonation (must have separator to avoid blocking 'admins'-as-substring etc)
  IF v ~ '^admin[._]'        THEN RETURN true; END IF;
  IF v ~ '^support[._]'      THEN RETURN true; END IF;
  IF v ~ '^staff[._]'        THEN RETURN true; END IF;
  IF v ~ '^official[._]'     THEN RETURN true; END IF;
  IF v ~ '^moderator[._]'    THEN RETURN true; END IF;
  IF v ~ '^help[._]'         THEN RETURN true; END IF;

  -- Suffix patterns — system role impersonation
  IF v ~ '_admin$'           THEN RETURN true; END IF;
  IF v ~ '_support$'         THEN RETURN true; END IF;
  IF v ~ '_staff$'           THEN RETURN true; END IF;
  IF v ~ '_official$'        THEN RETURN true; END IF;
  IF v ~ '_team$'            THEN RETURN true; END IF;
  IF v ~ '_mod$'             THEN RETURN true; END IF;
  IF v ~ '_moderator$'       THEN RETURN true; END IF;
  IF v ~ '_help$'            THEN RETURN true; END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.is_reserved_username(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_reserved_username(text) TO authenticated, anon, service_role;

COMMENT ON FUNCTION public.is_reserved_username(text) IS
  'Single source of truth for reserved usernames. Returns true if the input matches the exact reserved list OR a brand/role impersonation pattern. Called by check_username_available, check_username_with_suggestions, claim_social_profile, and the handle_new_user trigger.';
