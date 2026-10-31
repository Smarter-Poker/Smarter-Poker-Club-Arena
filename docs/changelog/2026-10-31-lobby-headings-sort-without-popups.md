# Lobby Headings Adjust The Board Without Popups

Stakes and other sortable headings now adjust the rows directly in compact and wide schedules. The old Stakes and Game Variant popup renderers, open state, outside-tap handlers and page callback wiring are removed. The dedicated Filters sheet continues to own game and style selections.

Game and Variant headings are static information. Old saved Game/Variant sorts no longer override the normal board order. MTT top-event locks and status priority remain intact. Pointer and keyboard sorting, remembered numeric directions and filter-sheet sort synchronization retain their existing paths.

This intentionally supersedes the older heading-popup expectations under the owner's October31 request. Retained tests cover direct sorting, static Game, old preference recovery, canonical stakes ordering, style filters and unchanged row information.
