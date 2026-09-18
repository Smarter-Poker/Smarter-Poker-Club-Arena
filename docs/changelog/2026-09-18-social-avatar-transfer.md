# 2026-09-18 - Size social JPEG portrait downloads

The shared PlayerAvatar bypassed the existing public Storage image-sizing helper and downloaded original JPEGs for 28-84px portraits in friends, profiles and leaderboard podiums. It now requests the existing 2x retina size, keeps the original URL as a single fallback if transformation fails, and retains the existing generated fallback if the original also fails. Source changes and failure recovery continue to update the portrait.

Signed URLs, library art, third-party sources, inline images and animation-capable formats remain intact. This uses the existing transformation service and retains artwork, layout and source files. Transformed origins are separately metered; this is not a guaranteed invoice saving.

Verification: seven connected regressions failed before the source correction; 71 related tests across five files and the root compiler passed after it. The observed ten-minute original-avatar traffic was 87,712,953 response bytes across 100 requests, including 57,979,117 bytes of JPEGs. This does not attribute that entire sample to this component or reconstruct historical billed transfer.
