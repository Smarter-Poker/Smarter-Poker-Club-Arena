# Live table menus retain the public hand identity

The standalone table menu and shared multi-table menu omitted TableMenu's supported hand number. Both now receive the owning table page's engine hand identity, using the existing table-info callback and tab projection. Updates reach an already-open menu while observing, switching tables selects only the active table, and a moved tab starts without the departed table's hand. No new clock, request, financial action or automatic table switch is added.

The rendered menu regression fails on the original source and checks successive hands, active-table isolation and the lobby boundary. Source contracts retain the connected table-page report and both menu callers. Physical-device progression and current-release verification remain required after publication.
