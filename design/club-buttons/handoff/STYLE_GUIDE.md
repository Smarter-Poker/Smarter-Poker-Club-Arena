# #ClubButtons Style Guide

## Visual language

Premium casino hardware: near-black textured interiors, brushed gunmetal and polished silver rails, crisp beveled corners, controlled depth, and small electric-blue crystal/light accents. The result should feel manufactured, balanced, and tight—not like generic cards with gradients.

## Color and finish

- Base: near-black and charcoal.
- Metal: cool silver/gunmetal with narrow highlights and dark bevel shadows.
- Primary accent: electric/cobalt blue, used sparingly at crystal tips, active rails, values, and focus states.
- Success: restrained emerald green.
- Danger: restrained deep red along the inner rail; never a decorative red tail.
- Gold: reserved for featured or prize emphasis.
- Avoid broad glow washes, title gradients, and top/bottom “shine effect” bands.

## Typography

- Display labels may use the established condensed/casino display treatment in the approved artwork.
- Live HTML values and controls use the app's self-hosted typography and must remain crisp at mobile sizes.
- Values use tabular numerals and stable alignment.
- Never rasterize changing names, balances, counts, times, statuses, or button labels.
- Prevent descender clipping (`g`, `y`, `p`) with adequate line-height.

## Layout

- Mobile first; no horizontal crop or sideways scrolling at 320 px.
- Elements share axes. Icon, title, value, and arrow zones must remain balanced.
- Desktop command center maximum is approximately 1050 px.
- Command-center vertical proportions: header 14%, controls 14%, campaign 11%, game display 61%.
- Joined sections use 5–8 px visual separation and shared rails, not large card gaps.
- Mobile command top becomes three full-width sections; game tables become cards.

## Iconography

- Icons are metallic and legible with only a splash of color.
- Blue crystal accents sit inside their intended triangular gaps and never bleed into adjacent rails.
- Icon medallions and their labels must be centered and visually equal in weight.

## Do / do not

Do preserve artwork as hardware and overlay semantic live UI. Do test maximum-length content. Do use real focus states and minimum touch targets.

Do not create generic CSS approximations of approved artwork. Do not stretch images. Do not add decorative protrusions to the right edge. Do not reuse one icon for unrelated wallet types. Do not globally affect non-Club-Arena controls.
