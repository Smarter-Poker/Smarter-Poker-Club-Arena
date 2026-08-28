# 2026-08-28 — Mobile optimizations round 4 (Dan's 11-item list)

Agent: cowork-mobile. Branch: `agent/cowork-mobile/fix/mobile-optimizations-0828`.

1. **Stale BBJ banner on every login — fixed at the root.** The bbj_pools
   UPDATE handler read `payload.old.hit_count`, which default replica identity
   never carries, and `_LAST_BBJ_HIT_COUNT` restarts at 0 per page load — so
   the first pool tick after login always announced the latest HISTORICAL hit.
   The baseline is now seeded from the pool's live `hit_count` before
   subscribing. Second gate: the emitter read `hit.hit_at`, a column
   `fn_bbj_recent_hits` never returned — now `hit.awarded_at`, so freshness
   really applies. Third: `shouldAnnounceBbjHit` gained `requireStamp`; the
   global banner path refuses unstamped (unprovable) events. Tests added in
   `tests/unit/bbjHitOnce.test.ts`.
2. **Action-pill cards centered.** The active cards pill still reserved 15px
   right padding for the × removed on 2026-08-26. Symmetric 4px now.
3. **P&L tracker** only engages at 2+ REAL tables (lobby tabs no longer
   count), the tab-bar wrapper paints one background (same gradient as the
   strip), and the chips bottom-align so the tile-view box touches the table.
4. **Hero ALL IN above head / chips moved out.** `.seat--hero .seat__action`
   top -8px; `.seat--hero .seat__bet-chips` lifted 30px toward the pot;
   collect-flight delta compensated in TablePage.
5. **Settings apply live.** Table color theme moved off `data-theme` onto
   `data-color-theme` (the light/dark interface mode owns `data-theme` now —
   they were overwriting each other). Animation-speed read-back un-inverted;
   `showBetSizePresets` read back for real; settings panel avatar row wired
   to `heroAvatarUrl`; TablePage subscribes to USER_PROFILE_LOADED so the
   hero avatar updates everywhere without reload; `pickThemeRow` is
   last-write-wins between a bucket row and a newer Apply-To-ALL row.
6. **Pot moved down** (19% → 23% + POT_ANCHOR_PCT.y in the same commit) so
   the top seat's bet chips can never touch the pot pill.
7. **Cash buy-ins are 40BB-200BB.** Migration
   `20260828_cash_buyins_are_40bb_to_200bb.sql` APPLIED to production (6 rows
   corrected, incl. `NLH 25/50 INSURANCE TEST` at 100/200 = 2-4BB).
   TableConfigPage default max 100BB → 200BB and slider floor 2BB → 40BB;
   HorseFleetManager reuse branch now resyncs buy-ins with the blinds.
8. **Icon black backgrounds gone.** CSS: `.tbc-widget`,
   `.rabbit-hunt__button`, `.mini-stats-card--tournament-stats` got the
   2026-08-26 transparent treatment; `.add-chips-icon-btn:active` white flash
   and the control-strip ::after glass removed. ASSETS: all 14
   `assets/buttons/{black,blue}/icon-*.webp` in Supabase Storage re-exported
   with real alpha (geometric rounded-rect/circle masks fitted to the rim) and
   upserted to the same paths — the square canvases were baked into the art.
9. **Add-table + button** is now the metallic circled plus (inline SVG,
   chromeless button).
10. **Bet slider silver.** Track fill hardcoded brushed silver (webkit +
    -moz); `--color-raise` untouched (it also paints the RAISE button).
11. **Cards over avatars, always.** Top-cap reveal no longer drops below the
    plate — it centres OVER the avatar; `seat-wrapper--showing` also holds
    during all-in runouts (status all_in with dealt cards), so merge jitter
    can't drop a face-up seat behind a neighbour.
12. **Equity % smart placement.** Default above the avatar
    (`equity-overlay--above`); top-cap seats dock to the side away from any
    neighbouring all-in badge; seats with a badge lift to z 28
    (`seat-wrapper--equity`).

Verification: `npx tsc --noEmit` clean (client + server);
`npx vitest run tests/` 517 files / 8090 tests green; server
HorseFleetNoDuplicateTables 6/6 green. Migration verified applied (0
deviating cash rows). Icon uploads verified re-served with alpha.
