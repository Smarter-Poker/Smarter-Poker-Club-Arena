-- Four missing foreign keys. Each one makes a PostgREST embed that has been
-- returning 400 PGRST200 on every call, for every user, start working.
--
-- Found by replaying every `.from(X).select(...embed...)` in src/ against this
-- database exactly as @supabase/postgrest-js sends it (whitespace outside
-- double quotes stripped). 7 of 37 embeds were broken; these 4 FKs fix 5 of
-- them. The other 2 are code bugs, fixed in the same PR, and the sweep is now
-- a blocking CI gate (scripts/ci/check-embed-relationships.mjs).
--
-- Delete rule is CASCADE on the three -> profiles keys because that is what
-- every existing -> profiles FK in this schema already uses (7 of 7, including
-- user_blocks.blocker_id, whose partner column this adds).

-- 1. CashoutService.getCashout embeds `agent:agent_id(display_name)`.
--    player_id already had its FK; agent_id never did. 0 rows, 0 orphans.
alter table public.cashout_requests
  add constraint fk_cashout_requests_agent_id_profiles
  foreign key (agent_id) references public.profiles (id) on delete cascade;

-- 2. BlockService embeds `profiles:blocked_id(...)`. Mirrors the existing
--    fk_user_blocks_blocker_id_profiles. 1 row, 0 orphans.
alter table public.user_blocks
  add constraint fk_user_blocks_blocked_id_profiles
  foreign key (blocked_id) references public.profiles (id) on delete cascade;

-- 3. TableService.getSeatedPlayers and FriendSuggestionService both embed
--    profiles off table_seats.user_id. 54,647 rows, 0 orphans, 17 MB — small
--    enough to validate inline.
alter table public.table_seats
  add constraint fk_table_seats_user_id_profiles
  foreign key (user_id) references public.profiles (id) on delete cascade;

-- 4. TransactionHistoryPage embeds `clubs (name)`.
--    NOT VALID DELIBERATELY. chip_transactions holds 86,183 rows and SIX of
--    them point at clubs that no longer exist — all from March 2026, all
--    obvious test artifacts (club_id 00000000-...0001 and 99999999-..., notes
--    "test" and "CLAIMED_FOR_CLAWBACK"). These are money rows in an audit
--    trail; deleting or rewriting them to satisfy a constraint would be worse
--    than leaving them. NOT VALID registers the relationship (which is all
--    PostgREST needs) and enforces it on every NEW row, while leaving the six
--    historical rows intact and findable.
--
--    To finish the job later, decide what those six should be and then:
--      alter table public.chip_transactions
--        validate constraint fk_chip_transactions_club_id_clubs;
alter table public.chip_transactions
  add constraint fk_chip_transactions_club_id_clubs
  foreign key (club_id) references public.clubs (id) on delete set null not valid;

-- PostgREST resolves embeds from its schema cache. Without this the fix only
-- takes effect on the next connection reload.
notify pgrst, 'reload schema';
