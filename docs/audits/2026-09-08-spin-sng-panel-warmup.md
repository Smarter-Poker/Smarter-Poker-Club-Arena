# Spin and Sit N Go entry prepares the actual table

A live observer pass opened a running PLO6 Spin through its game panel and Watch button. The table eventually showed live seats and action, but the panel-to-table path still displayed Opening The Table. Source inspection found that opening the panel warmed only cash tables. The comment said Spin/SNG would warm at the later entry tap, but both successful Spin/SNG navigation paths also omitted warmTable.

Opening a Spin or SNG game panel now resolves the canonical live table and begins its roster/socket preparation while the player reads the panel. The entry action still resolves the canonical table again, because tournaments can recycle. Both the original-table and sibling-table success paths warm the actual destination before navigation. Tournament IDs are never passed as table IDs, and no registration or purchase is introduced.

Preparation remains best effort. This does not remove the honest opening state while the authoritative destination is unknown, and it does not prove instantaneous entry on every network. Production verification after publication remains required.
