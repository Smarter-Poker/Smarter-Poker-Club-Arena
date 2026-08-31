# Phase One Customization Closure

## What the audit found

The player-facing customization path remained green, but the production build
could not honestly prove that it came from a clean protected checkout. The
thumbnail generator compared file modification times. Git does not preserve
those times, so a clean CI checkout regenerated a varying subset of committed
Table Studio thumbnails before provenance was stamped. Production therefore
reported `dirty: true` even when no source edit existed.

## What changed

- Production builds now generate only missing customization derivatives.
- Refreshing existing derivatives is an explicit authoring command:
  `npm run assets:customization-thumbnails`.
- A regression contract prevents checkout timestamps from becoming build
  inputs again.

The source art and committed thumbnails are unchanged. This is a build
integrity correction, not a visual redesign.

## Real-time law

No visible state path changed. Table appearance still applies immediately via
the named `UI_THEME_CHANGED` event, cross-device ownership continues through
the owner-filtered `theme_asset_unlocks` Realtime stream, and the MTT Final
Table presentation remains driven by the discrete `final_table` event.
