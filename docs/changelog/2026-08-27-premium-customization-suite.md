# Premium Customization Suite

## What Existed

Table Studio exposed the real cosmetic assets and a compact table-only preview. It did not show
avatars, player plates, a board, pot, action controls, discovery filters, favorites, recent choices,
or reusable loadouts. The MTT `final_table` event selected a dedicated felt but retained the player's
ordinary room background.

## What Changed

- The preview now paints a representative six-seat hand and obtains its portraits exclusively from
  `AvatarService.getAvatarLibraryResult`, the same 97-avatar production library used by the avatar
  gallery.
- Standard and Final Table states can be compared inside the studio.
- Search, free/VIP/favorite/recent filters, shuffle, and three local saved loadouts were added using
  mobile-first controls.
- A portrait Final Table broadcast arena was added as an event-only asset and is activated by the
  existing discrete `final_table` WebSocket event.
- The live Final Table now has a compact persistent championship HUD and a refined arrival overlay.

## Compatibility

Old theme rows continue through the existing normalization and fallback paths. Favorites, recents,
and loadouts are isolated per signed-in user in local storage; malformed stored values safely reset
to empty collections.

## Real-Time Law

Final Table presentation is triggered by the existing `final_table` discrete WebSocket event. No
snapshot diffing or polling was added.
