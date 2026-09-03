# Design and Export Rules

## Source-of-truth rule

`design/club-buttons/` owns design references and production masters. `public/assets/club-buttons/` contains runtime copies. `src/components/club-buttons/` owns shared semantic component behavior. Avoid parallel implementations.

## Naming

Use lowercase kebab case: `<family>-<variant>-v<number>.<ext>`. Add `-approved` only to reference artifacts, not runtime URLs. Never use `final-final` naming.

## Artwork exports

- Preserve transparency when the component needs an irregular silhouette.
- Use WebP for optimized runtime artwork and retain a PNG master where useful.
- Do not bake dynamic content into artwork.
- Preserve native aspect ratio; use `object-fit: contain` when a complete frame must remain visible.
- Keep all crystal tips, corner caps, and bottom medallions inside the export canvas.
- Runtime artwork must be served from the Club Arena base path and verified in a production build.

## Responsive safety

- Start at 320 px and scale upward.
- Validate 320, 375, 390, 430, 768, 1024, and 1440 px.
- No frame edge, title, status, value, or bottom chip may be clipped.
- Mobile game cards are reflowed templates, not a cropped desktop table.
- Semantic action areas remain at least 44 px high where practical.

## Approval and versioning

Keep approved work unchanged. Create a new version for experimental revisions and list it in `REJECTED_OR_SUPERSEDED_ASSETS.md` if rejected. A visual change is not production-ready until the user approves a rendered example with representative data.
