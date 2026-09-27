-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419230045 "phase38_schema_documentation_regulatory_posture"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3b37b2c6007ca96d3d24e401f7ddf389 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- PHASE 38: Schema-level documentation of regulatory posture for home games.
-- Makes the constraints visible to anyone doing \d+ / pg_dump / schema inspection
-- without having to read migration files. Future devs and agents see it first.
-- ============================================================================

-- ── Table-level posture ─────────────────────────────────────────────────
COMMENT ON TABLE public.commander_home_games IS
    'Home poker games organized by user-created groups. REGULATORY POSTURE: '
    'Smarter.Poker is NOT a money intermediary for home games. The platform '
    'does not take fees, rake, or host commissions; does not escrow or settle '
    'buy-ins; does not pay hosts for running games. Financial-looking columns '
    '(stakes, buyin_min, buyin_max) are INFORMATIONAL ONLY — used for display '
    'and discovery, never for money movement. See also: CHECK constraint '
    'no_home_games_source on diamond_transactions.';

COMMENT ON TABLE public.commander_home_groups IS
    'User-created home-poker groups. Owners/admins manage membership, host '
    'games, and run a private social layer. REGULATORY: same informational-'
    'only posture as commander_home_games — no money movement, no platform '
    'fees, no host compensation from the platform.';

COMMENT ON TABLE public.commander_home_game_templates IS
    'Reusable game configurations (stakes / buy-in ranges / format) that hosts '
    'can apply when creating games. REGULATORY: informational-only, same posture '
    'as commander_home_games.';

COMMENT ON TABLE public.commander_home_rsvps IS
    'Guest RSVPs for home games. Tracks response, check-in, and flake status '
    'for group reputation and rsvp analytics only. REGULATORY: no money is '
    'collected, escrowed, or transferred in association with any RSVP.';

COMMENT ON TABLE public.commander_home_seats IS
    'Live seat map for a game in progress. Tracks who is sitting at which seat, '
    'with status (empty/reserved/seated/away) and per-seat notes. REGULATORY: '
    'no chip counts, no stack tracking, no settlement — seats are a coordination '
    'tool, not a transactional surface.';

-- ── Money-looking columns ───────────────────────────────────────────────
COMMENT ON COLUMN public.commander_home_games.stakes IS
    'Human-readable stakes descriptor shown to invitees (e.g. "1/2 NL", "5/10 PLO"). '
    'Display only. Never used for any transactional calculation.';

COMMENT ON COLUMN public.commander_home_games.buyin_min IS
    'Informational minimum buy-in in integer units (typically dollars). Used to '
    'help invitees understand the game. Never collected, escrowed, or settled by '
    'the platform.';

COMMENT ON COLUMN public.commander_home_games.buyin_max IS
    'Informational maximum buy-in. Same posture as buyin_min.';

COMMENT ON COLUMN public.commander_home_groups.default_stakes IS
    'Default stakes string shown on group page. Display only.';

COMMENT ON COLUMN public.commander_home_groups.typical_buyin_min IS
    'Informational typical-minimum buy-in for the group. Display only.';

COMMENT ON COLUMN public.commander_home_groups.typical_buyin_max IS
    'Informational typical-maximum buy-in for the group. Display only.';

COMMENT ON COLUMN public.commander_home_game_templates.stakes IS
    'Display-only stakes descriptor copied onto games that use this template.';

COMMENT ON COLUMN public.commander_home_game_templates.buyin_min IS
    'Display-only buy-in floor copied onto games that use this template.';

COMMENT ON COLUMN public.commander_home_game_templates.buyin_max IS
    'Display-only buy-in ceiling copied onto games that use this template.';

-- ── Rate-limit log tables (already commented in Phase 37, re-asserting here) ─
COMMENT ON TABLE public.commander_home_group_view_log IS
    'Phase 37 rate-limit state for track_home_group_view. Pruned daily by '
    'home-view-log-prune cron (7-day retention). Not user-facing; no RLS '
    'policies (service_role only).';

COMMENT ON TABLE public.commander_home_group_share_log IS
    'Phase 37 rate-limit state for track_home_group_share_click. Pruned daily '
    'by home-view-log-prune cron (7-day retention). Not user-facing; no RLS '
    'policies (service_role only).';
