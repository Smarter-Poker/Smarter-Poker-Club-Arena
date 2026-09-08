# Premium throwable artwork, loading and charge protection

Replace vector moving artwork with premium stylized atlas parts for 37 existing non-glove rigs. Preserve the normalized player coordinate system and measured beats, add separate prop actions and expression sequences, and retain legacy playback for the remaining catalogue. This is an incomplete implementation checkpoint, not a release-completion claim.

Runtime artwork uses lossless WebP, preserving visible pixels and alpha while reducing 39 sheets from 55,159,091 to 39,514,002 bytes. Preserve source PNGs outside public assets. Verify decoded dimensions and await artwork before spending or starting animation/audio. Failed loads retry, and closing the picker cancels uncharged intent. Immediate/reduced-motion payloads use the correct audio clock.

Keep request UUIDs across uncertain billing responses. Remove a post-payment client timer that could discard paid throws. Two database migrations, already applied, prevent locked pack credits from being skipped in favor of diamonds and timestamp consumption with clock_timestamp so delayed transactions cannot bypass cooldown. Their guarded function replacements preserve privileges.

Verification: 18 local PostgreSQL checks using exported production functions and synthetic tables, plus live function/privilege reads after each migration. Full-checkout TypeScript and focused frontend tests pass; final full-suite/build after merging main remain required. Local payload previews verify speed normalization and reduced motion. Organic/voice audio, additional catalogue and entitlement work, authenticated commerce/multiplayer/device checks and publication remain unfinished. See docs/throwables/MOVING-PARTS-STATUS.md.
