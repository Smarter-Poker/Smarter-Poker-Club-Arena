# Smarter Casino Table Studio

2026-08-29. Club Arena's selectable table appearance is now owned by one
mobile-first Table Studio instead of being split between the hamburger menu,
the in-table settings sheet, `/settings`, and partially disconnected legacy
selectors.

## The experience

- The studio is full-screen at phone widths and becomes a 92vw, two-rail
  workstation on larger screens: 44% live gameplay preview and 56% catalog.
- The presentation follows `#SmarterCasinoRealism`: obsidian and gunmetal
  structure, machined silver, restrained broadcast blue, VIP brass, Rajdhani
  display type, tactile controls, and no dashboard-style white cards.
- Light mode uses brushed-silver casino hardware; dark mode uses the same
  hierarchy in blackened metal. The choice is live and remains part of the
  global interface settings.
- Every selectable background and table is displayed with `object-fit:
contain`. A blurred ambient copy fills unused framing behind backgrounds,
  so the actual artwork is never cropped merely to fill a tile.
- The preview composes the real background, table skin, seat plates, card back,
  action buttons, and existing avatar-library imagery. It also includes the
  event-driven final-table broadcast treatment; no preview-only avatars were
  invented.
- The catalog has explicit Themes, Table, Buttons, Background, and Cards tabs.
  Buttons now has ten choices and **White D** (`classic-white`) is the first,
  free, canonical default.
- The ten composite themes now have distinct premium names and resolve through
  the same real table/background/button registries that gameplay uses.

## One owner, one live path

All selectable visual controls were removed from:

- the hamburger's former Card Colors section;
- the behavior-only Table Preferences sheet;
- the duplicate felt/card-back controls in the in-table Settings panel;
- the disconnected Card Back Style dropdown on `/settings`.

Each of those reachable surfaces now opens the same Table Studio. A selection
immediately emits `UI_THEME_CHANGED`; every open table and every open studio
instance consumes that event. `applyTableAppearance` serializes writes per
user/game bucket, preserves the order of rapid taps, writes only the changed
columns, and rolls back only a failed optimistic field. Server echo and the
first-paint cache keep refreshes and second tabs aligned with the durable row.

The consolidation also removed an unreachable HomePage card-color bus
subscription and its profile-preference query. Once the old hamburger picker
was removed, nothing could publish or consume that preference; retaining it
would have left a silent event handler and one unnecessary mobile round trip.

## Production catalog repair

The UI already exposed 30 backgrounds, but production's `cosmetic_catalog`
knew only the original ten. The ownership trigger therefore rejected every
one of the 20 Places/Rooms and Skins choices. The UI also marked fifteen
backgrounds free while the database allowed three, and the free Ocean Suite
preset bundled VIP assets.

`20260829163000_sync_extended_background_catalog_and_cardback_entitlements.sql`
closes those gaps:

- registers all 20 extended backgrounds as VIP assets;
- keeps the three canonical free backgrounds (`midnight`, `royal_indigo`, and
  `emerald_room`) and grandfathers already-equipped premium rows;
- recognizes card backs purchased through `feature_purchases` as well as
  `theme_asset_unlocks`, so a just-purchased back can be equipped immediately;
- rejects unknown asset ids instead of letting catalog drift hide;
- asserts 30 backgrounds, exactly three free backgrounds, and no orphaned
  saved theme rows.

The migration was applied to the linked production database. Post-apply checks
returned 30 backgrounds, 3 free backgrounds, 10 Places/Rooms, 10 Skins, and 0
orphaned `user_theme_settings` rows. The client/catalog drift checker is green.

## Regression coverage

`tests/config/tableStudioArchitecture.test.ts` pins:

- Table Studio as the sole selectable-appearance owner;
- ten themes, ten buttons, and White D as the default;
- all 30 background ids in the client and all 20 extended ids in the database
  migration;
- full-viewport mobile layout, the desktop split, uncropped foreground art,
  and ambient-only cover behavior.

The existing real-time, first-paint cache, ordered-write, entitlement, asset
resolution, and no-dead-bus suites remain green. Final local verification:
579 test files, 8,859 passing tests, one intentional skip, TypeScript clean,
catalog drift clean, and a successful production build.
