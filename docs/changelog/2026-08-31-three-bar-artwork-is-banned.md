# Three-Bar Artwork Is Banned

The Club Arena navigation drawers now use the premium metallic command-center
gear instead of the legacy three-horizontal-line artwork. The replacement is
wired into the global header, floating navigation trigger, table command
center, and legacy shell fallback.

The old raster files were removed, the baked global header was rebuilt with
the command-center gear, and remaining three-bar glyphs in transaction,
leaderboard, promotion, wallet, and table-rules surfaces were replaced with
semantic symbols.

A source and asset law test now rejects the banned glyphs, legacy asset names,
runtime references, and any unexpected byte change to the approved replacement
artwork.
