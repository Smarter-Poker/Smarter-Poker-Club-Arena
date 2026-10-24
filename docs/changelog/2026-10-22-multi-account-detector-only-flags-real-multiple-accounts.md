# 2026-10-22 The Multi-Account Detector Only Flags Real Multiple Accounts

Dan: "you are basically flagging everyone for multiple accounts... do not flag
smarter.poker official or any admin accounts ever. and improve your algorithm
... to truly only flag multiple accounts, not multiple log ins."

## Cause

`/cron/anti-cheat-multi-account` (smarter-poker-workers) flagged every account
that opened an engine socket from the same IP as another account inside 24
hours (`multi_account_ip_match_v1`). That caught SmarterPokerOfficial and the
admin accounts on Dan's home address, the synthetic PostDeploy smoke accounts on
GitHub's Azure runners, and players behind iCloud Private Relay, and re-flagged
them every day. 45 open flags, none of them multiple accounts.

## Fix

- **Staff never flag.** `fn_anti_cheat_is_staff` / `fn_anti_cheat_never_flag`
  (admin, god, owner, staff, PostDeploy) are removed before any matching, so
  they neither get flagged nor get anyone else flagged. The
  `anti_cheat_flags` insert trigger refuses any flag on a staff account as a
  second wall. A device any staff account used is a staff device.
- **Detector v3** (`detect_multi_account_v3`, migration 20261022220915):
  - critical: same app/browser install AND dealt into the same hands;
  - high: same install, or same household address AND dealt into the same
    hands while both were on it (hand_history.players via its GIN index);
  - medium: 2+ distinct household addresses;
  - nothing: one shared address on its own, relay or cloud addresses, any
    address used by 6+ accounts (a venue or carrier NAT).
- **Device signal.** `src/lib/deviceSighting.ts` keeps one install id per
  browser/app and reports it once per signed-in session through
  `ca_record_device_sighting`; the database reads the address from the
  request headers, never from the client.
- **Published shared-address lists.** The workers service refreshes Apple
  iCloud Private Relay, AWS, Google Cloud, Cloudflare, GitHub Actions and Azure
  into `anti_cheat_shared_ip_ranges`, one stale source per run, weekly; a
  failed download keeps the previous list.
- **Readable flags.** The Anti-Cheat Flags tab renders the reason as a sentence
  ("Same Device · 14 Hands Played Together With ...") with links to the other
  accounts (`src/utils/antiCheatFlagReason.ts`).

## Settled

The 45 open v1 flags were dismissed with a note. Against the last 30 days of
traffic, v3 finds no pairs.

## Pinned

- workers: `src/routes/anti-cheat-multi-account.law.test.ts`,
  `src/lib/sharedIpRanges.test.ts`
- club-arena: `tests/unit/deviceSighting.test.ts`,
  `tests/unit/antiCheatFlagReason.test.ts`

Migrations 20261022163616, 20261022170343, 20261022173217 and 20261022220915
were applied to production through the MCP and are recorded byte-identical in
`scripts/ci/recorded-migrations.manifest.json`. Horses go through every rule
exactly as humans do (CLAUDE.md 10.5).
