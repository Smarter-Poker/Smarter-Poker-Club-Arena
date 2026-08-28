# 2026-08-28 — Settings that said "saved" and did nothing

## /settings Sound Effects toggle never reached the sound engine

The switch persisted `soundEnabled` into `club-arena-table-settings`, but the
gate that silences playback (`utils/soundGate`, consulted by
`SoundService.shouldPlay`) reads `club_arena_sounds` / `ca_sound_enabled` —
neither of which the page wrote. Muting said "Settings saved!", the felt kept
playing, and the in-table switch still read ON. `saveSettings` now calls
`soundService.setEnabled()` (live engine + BOTH gate keys, the HamburgerMenu
path) and applies the volume live.

## Tab-bar "Sounds" item was wired to a dead key

TablePage's TOGGLE_SOUNDS branch wrote `table_sound_muted` — a key nothing
reads (soundGate documents it as outside the contract) — and emitted a
`sound_muted` bus field no settings store accepts. The menu item did nothing:
no mute, no badge change, no error. It now routes through
`setIsSoundEnabled(!soundService.isEnabled())`, the same path as the in-table
sound switch (state + engine + both persisted keys).

## /settings "Confirm All-In" toggle removed

It saved and synced, but ActionPanel destructures the prop to
`_confirmAllInDeprecated` and never reads it; the in-table SettingsPanel
removed its copy for the same documented reason ("accept the action"). The
control is gone; the stored field stays for old saves.

## Verified already fixed on main (no action; noted so they are not re-flagged)

- `data-theme` clobber: useTableSettings now writes `data-color-theme`
  (2026-08-28, another agent) — the table color palette no longer overwrites
  light/dark mode, and the in-table "Table Theme" dropdown is live again via
  the doubled selectors in design-tokens.css.
- TableModalsLayer now passes `userSettings.showBetSizePresets` instead of a
  hard-wired `true`, so that toggle renders its real state.

## Still open, deliberately not band-aided here

- `SoundService` reads `sp_sound_settings` at boot but its writer
  (SoundSettings.tsx) does not exist in this repo: the five per-category
  switches and effects volume are locked at defaults. Needs a UI decision,
  not a patch.
- The felt-skin fallback `v8Theme.table_id || … || userSettings.theme` still
  makes `userSettings.theme` unreachable for the FELT (v8Theme.table_id can
  never be falsy). Harmless now that the dropdown drives the app palette via
  data-color-theme, but the felt itself is owned solely by Theme Settings.
