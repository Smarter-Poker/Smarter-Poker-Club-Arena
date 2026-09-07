# Champagne, Horseshoe and Snowman material revision

Three more existing rigs receive dimensional material detail while retaining
their measured spec, audio and CSS beats.

Champagne: folded neck foil, a stamped label seal, cork grain and top face,
refraction highlights, an elliptical liquid surface and defined flute rims.
Horseshoe: a rounded U-shaped forged body replaces the pointed V silhouette,
with a bevel, depth face, recessed nail holes and shaped, veined clover leaves.
Snowman: a shaped and shaded top hat, inset coal eyes, snow contours, a
consistent spherical nose across the intact and residue phases, and a shaped
powder plume with overlapping contours.

Registry callers remain unchanged. Each new gradient uses the rig instance
UID, including each clover and each intact/residue nose. No new hooks,
network calls, timers, audio cues or runtime dependencies are introduced.
React best-practices review found no new waterfall, global listener or state
subscription. The art remains SVG with dimensional lighting, not 3D models.

Validation: 50 tests pass in specs, measured-grammar laws and darkroom CLI
suites; strict scoped TypeScript passes for the three rigs. Chromium captured
36 beat/rung frames at 56/66/84/104 avatar sizes and six 3x detail frames.
The frames and enlarged details were visually inspected, leading to the
Horseshoe silhouette correction before the final capture. All 230 SVG
resource IDs in the simultaneous darkroom tiles are unique. The detail sheet
has a deliberate cropped view of the powder plume; the complete plume is in
the contact and material sheets. Screenshots are in
`docs/throwables/reviews/2026-09-07-fourth-material-pass/`.

This brings the material-revision count to eleven of the original eighteen,
not completion of the overall task. Seven existing rigs still need material
revision; thirty catalogue items remain on the legacy player. Picker art,
new characters/store items, voice recordings and authenticated end-to-end
browser flows remain unfinished. The item-by-item handoff audit is updated.

PR #3503 merged as 0ea76a50ca02d55e08aa0cec30857d4a0c95ca92. This branch
starts there. The most recent production read returned 26cdc770db5e852d6ed68a3ba423d5411e9bd91a,
built at 2026-09-07T20:15:05Z, so publication of this new art is not claimed.
Full build and full suite remain CI gates for this partial source workspace.
No hooks or guards were bypassed.
