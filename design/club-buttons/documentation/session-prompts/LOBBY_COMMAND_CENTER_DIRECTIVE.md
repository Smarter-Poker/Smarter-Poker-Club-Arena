# MASTER CODEX IMPLEMENTATION PROMPT

# SHARK CLUB TOURNAMENT LOBBY, SINGLE-FRAME SMARTER.POKER CASINO REDESIGN

You are modifying the existing Club Arena / Smarter.Poker codebase.

Your assignment is to visually rebuild the Shark Club game/tournament lobby shown in the attached approved reference image.

THIS IS A VISUAL IMPLEMENTATION OF AN EXISTING WORKING SCREEN.

DO NOT rebuild its business logic.
DO NOT invent fake data.
DO NOT replace working APIs.
DO NOT remove existing handlers.
DO NOT alter live gameplay screens.
DO NOT modify World Hub.
DO NOT modify Club Commander.

Preserve all existing functionality and real dynamic data.

The attached approved reference image is the PRIMARY VISUAL SOURCE OF TRUTH.

---

1. PRIMARY OBJECTIVE
   \==================================================

Transform the current Shark Club schedule/tournament list interface into ONE cohesive premium casino-machine frame.

The entire presentation should look like one manufactured Smarter.Poker casino console.

Required vertical order:

1. Welcome To The Shark Club header
2. Find Your Game filter/control section
3. Advertisement banner
4. Tournament/game display
5. Bottom decorative frame area with centered poker-chip medallion

The finished page must visually read as ONE MACHINE.

Do not make it look like several unrelated cards stacked vertically.

## ================================================== 2. ABSOLUTE VISUAL RULES

The style is:

BLACK FIRST
BRUSHED GUNMETAL
POLISHED CHROME
BLACK GLASS
ELECTRIC BLUE ENERGY
PREMIUM CASINO HARDWARE
DEEP 3D
MECHANICAL
REFLECTIVE
HIGH-END
PHYSICAL
LAYERED

The result must NOT resemble:

- Flat SaaS cards
- Bootstrap panels
- Generic Tailwind UI
- Simple rounded rectangles
- Blue outlines around flat boxes
- Ordinary browser buttons
- Generic dashboard software
- Cartoon sci-fi UI

PASS TEST:

If it looks like a premium physical control panel removed from a high-end casino machine, PASS.

If it looks like a dark-mode web application with blue borders, FAIL.

## ================================================== 3. DO NOT CHANGE FUNCTIONAL BEHAVIOR

Before modifying the screen, inspect and preserve all existing:

- Tournament data
- Game data
- Filters
- Tab logic
- Sorting
- Registration state
- Tournament status
- Timers
- Guarantees
- Buy-ins
- Registered-player counts
- Route behavior
- Click handlers
- API calls
- Supabase behavior
- WebSocket behavior
- Realtime subscriptions
- Authentication
- Permissions
- Loading states
- Error states
- Mobile behavior
- Accessibility behavior

Existing functionality remains authoritative.

The rule is:

EXISTING FUNCTIONALITY +
NEW APPROVED VISUAL PRESENTATION
=

FINAL RESULT

## ================================================== 4. PROTECTED LIVE GAMEPLAY

DO NOT modify actual poker playing screens.

Do not alter:

/table/:tableId

or persistent multi-table gameplay.

Do not change:

- Poker table
- Felt
- Seats
- Cards
- Player positions
- Betting controls
- Gameplay utilities
- Pot
- Dealer button
- Animations
- Player avatars
- Live table geometry

This task is limited to the lobby/schedule presentation shown in the reference.

## ================================================== 5. SINGLE MASTER FRAME

The entire Shark Club lobby must be surrounded by ONE master hardware frame.

Do not create separate unrelated external frames for:

- Header
- Find Your Game
- Advertisement
- Tournament list

Instead, create one external chassis.

Internally, these sections may have inset rails, separators, recessed channels, or internal bevels.

The master chassis should use:

- Thick dark gunmetal outer structure
- Polished chrome highlight edges
- Angled clipped corners
- Mechanical corner joints
- Deep black center surfaces
- Subtle brushed-metal texture
- Recessed interior panels
- Small controlled blue illumination nodes
- Strong but tasteful physical depth

The outer frame must remain visually dominant over internal separators.

## ================================================== 6. OUTER FRAME CONSTRUCTION

The master frame should visually contain multiple layers.

Target approximately:

Layer 1:
External contact shadow.

Layer 2:
Dark gunmetal silhouette.

Layer 3:
Polished silver/chrome perimeter.

Layer 4:
Brushed-metal structural chassis.

Layer 5:
Inner machined bevel.

Layer 6:
Dark recessed channel.

Layer 7:
Controlled blue LED seam.

Layer 8:
Black-glass interior plane.

Layer 9:
Internal section separators.

Layer 10:
Specular highlights and mechanical detailing.

Use clipped mechanical corners rather than soft rounded corners.

Do not use excessive double framing.

Avoid redundant interior borders.

The frame should look substantial but clean.

## ================================================== 7. HEADER SECTION

The top of the master frame contains the club welcome header.

IMPORTANT:

DO NOT include the shark icon in the top header.

The approved structure is:

WELCOME TO THE
SHARK CLUB
ALL FISH OF ALL SHAPES AND SIZES ARE WELCOME!

Layout:

All content centered horizontally.

"WELCOME TO THE"

- small
- uppercase
- wide tracking
- silver
- elegant
- subtle metallic appearance

"SHARK CLUB"

- dominant header
- largest text in this section
- premium metallic silver
- dimensional
- embossed / engraved feel
- centered

Subtitle:
"ALL FISH OF ALL SHAPES AND SIZES ARE WELCOME!"

- smaller
- electric blue
- increased tracking
- elegant
- centered

The header background should be:

- dark black brushed texture
- subtle carbon-metal feel
- shallow glass reflection
- very restrained internal blue accents

Do NOT put a large image or mascot beside Shark Club.

## ================================================== 8. HEADER TYPOGRAPHY

Use:

Cinzel Bold

or the closest existing approved premium serif already present in the project.

SHARK CLUB:

- uppercase
- font-weight approximately 700
- wide tracking
- metallic silver treatment
- dimensional shadow
- slight top highlight
- subtle bevel appearance

Do not use plain white text.

The letters should visually resemble engraved polished metal.

Functional UI text should use:

Inter

Weights:

700:
important section labels

600:
buttons, filters, headers

500:
table content

400-500:
supporting information

## ================================================== 9. FIND YOUR GAME SECTION

Immediately below the welcome header:

FIND YOUR GAME
LIVE CLUB SCHEDULE
154 GAMES

This must feel like a built-in control console.

Do not make it look like a normal card.

Use:

- black glass
- shallow recessed surface
- thin machined internal rails
- subtle chrome edges
- controlled blue active illumination

Layout:

Left:
Find Your Game

Beside or near it:
Live Club Schedule

Right:
154 Games

The game count remains dynamic.

Do not bake "154" permanently into artwork if it is server-fed.

## ================================================== 10. GAME-TYPE FILTER CONTROLS

Maintain the existing options:

All
MTT
NLH
PLO
Limit
Spins
Heads Up
Filters

The exact options should continue coming from existing application behavior where appropriate.

Use premium slim mechanical segment controls.

DEFAULT:

- black-glass center
- dark gunmetal frame
- polished edge
- subtle inner shadow
- silver label

ACTIVE:

- blue illuminated edge
- blue-black interior
- slightly brighter face
- stronger local glow
- pressed/energized appearance

Do NOT make the entire control electric blue.

Blue is an accent.

LIMIT in the approved screenshot is the active example.

## ================================================== 11. SECONDARY FILTER ROW

Maintain existing filters such as:

All
Full
Empty
Open Seats
Favorites

These should be lower-profile than the game-type navigation.

Use:

- dark glass surface
- thin chrome edge
- shallow inset
- subtle bevel
- blue illuminated selected state

Avoid giant buttons.

## ================================================== 12. FILTERS CONTROL

The Filters control should be slightly distinct from category navigation.

Use:

- small utility-control styling
- control/settings/filter icon
- dark black face
- compact chrome frame
- blue illumination when active

Do not use a generic browser icon button.

Use the existing icon if appropriate or an approved icon asset.

## ================================================== 13. ADVERTISEMENT SECTION

Between Find Your Game and the tournament list, create a dedicated horizontal advertisement bay.

This is mandatory.

The ad must remain inside the same master outer frame.

Do NOT place the advertisement outside the master chassis.

The advertisement area should be a reusable container for dynamic promotional content.

Recommended architecture:

<AdvertisementSlot />

or the closest component structure appropriate to the codebase.

The ad area must support:

- Image
- Headline
- Subheadline
- Promotion information
- CTA
- Dynamic content
- Empty/fallback state

Do not hardcode one advertisement permanently.

The current approved reference demonstrates something like:

Shark Club Championship Series
$250,000 GTD Main Event
date
buy-in
late-registration information
Learn More

Treat those as design examples, not permanent fake data.

## ================================================== 14. ADVERTISEMENT VISUAL DESIGN

Advertisement bay:

- wide horizontal format
- recessed into the master chassis
- darker black-glass background
- chrome edge structure
- subtle blue internal reflection
- richer graphic content than ordinary UI
- premium event / casino promotion look

Possible left zone:
Tournament trophy / chips / poker visual.

Center:
Promotion headline and key amount.

Right:
Learn More or campaign CTA.

The CTA must remain a real semantic clickable control.

## ================================================== 15. TOURNAMENT DISPLAY

Below the advertisement is the large tournament/game display.

This must occupy the majority of the screen.

Treat it as a recessed electronic tournament ledger inside the master hardware chassis.

Do not render it as a generic HTML table visually.

The underlying semantic implementation may still use:

table
grid
rows
React components

but the presentation must look like a premium electronic tournament board.

## ================================================== 16. TOURNAMENT TABLE HEADER

Maintain the existing columns, conceptually:

Tournament Name
Starting Time
Game Type
Buy-In
Guarantee
Registered
Status

Preserve sorting functionality.

Sorting indicators must remain functional.

Header styling:

- dark gunmetal header strip
- subtle internal bevel
- very thin divider lines
- silver/gray uppercase labels
- Inter Medium or SemiBold
- small letter spacing

Avoid bright heavy borders.

## ================================================== 17. TOURNAMENT ROWS

Each tournament row should look like a shallow recessed data tray.

Use:

- near-black surface
- dark blue-black undertone
- very subtle metallic edge
- thin separation
- controlled hover glow
- precise vertical rhythm

Rows should not each have oversized chrome frames.

The master table frame provides most of the hardware.

Row styling should remain sleek and information-dense.

## ================================================== 18. FEATURED / SELECTED ROW

The featured first row receives enhanced presentation.

Use:

- stronger electric-blue left edge
- restrained blue outer glow
- deeper dark-blue interior
- brighter content
- more pronounced inset treatment

Badges such as:

Featured
You Are Registered

must remain readable and premium.

They should use small casino-status badges, not generic web pills.

## ================================================== 19. ROW STATUS INDICATORS

Use status-specific premium mini-controls.

Registering:
Blue

Late Reg:
Gold / amber

Active positive state:
Green where appropriate

Closed / cancelled:
Restrained red where applicable

Status treatment:

- black center
- thin metallic frame
- internal colored illumination
- concise text

Do not fill entire status buttons with saturated color.

## ================================================== 20. GAME TYPE BADGES

Short labels such as:

NLH
PLO5
PLO6

should be housed inside compact metal tags.

Use:

- black face
- gunmetal/chrome frame
- very restrained accent
- clear text

These are informational labels, not large action buttons.

## ================================================== 21. ROW LEFT INDICATOR

Use a small glowing blue activity dot at the start of each row as shown in the approved reference.

This should be subtle.

Featured / special rows may use an enhanced indicator.

## ================================================== 22. TABLE DATA COLOR HIERARCHY

Primary tournament name:
off-white / silver.

Guarantees:
electric-blue emphasis.

Positive countdown/status information:
muted green.

FREE:
green.

Registered numbers:
blue.

Secondary time/supporting data:
muted gray.

Do not overuse bright white.

## ================================================== 23. BOTTOM FRAME AND POKER CHIP

At the center of the master frame's bottom edge, integrate a premium poker-chip medallion.

IMPORTANT:

The bottom center icon must be a POKER CHIP.

Do NOT use:

- shark icon
- fish icon
- generic crest

The poker chip should look physically installed into the lower chassis.

Design:

- circular
- chrome outer ring
- dark black center
- blue illuminated accents
- poker/casino detailing
- subtle suit motif acceptable
- layered 3D appearance

The chip should slightly overlap or interrupt the lower frame rail.

It should feel mounted, not floating.

## ================================================== 24. REMOVE THE OLD SEPARATE WELCOME BANNER

The old separate bottom:

Welcome To The Shark Club...

banner is no longer needed because the welcome content is now integrated into the top header.

Do not duplicate the welcome message at the bottom.

The unified layout is now:

WELCOME HEADER
↓
FIND YOUR GAME
↓
ADVERTISEMENT
↓
GAME DISPLAY
↓
POKER CHIP / LOWER FRAME

## ================================================== 25. TEXTURE SYSTEM

Do not use flat CSS fills wherever visible.

Visually emulate:

BLACK SURFACES:

- black brushed aluminum
- satin black steel
- black glass
- light carbon texture

METAL:

- dark gunmetal
- polished chrome highlights
- brushed silver
- realistic reflections

GLASS:

- deep black
- very subtle diagonal reflection
- dark blue tint where illuminated
- inset appearance

Do not make textures noisy.

They should be perceived rather than distracting.

## ================================================== 26. BLUE ENERGY LANGUAGE

Electric blue is an energy accent only.

Use it at:

- active controls
- frame seams
- selected rows
- corner illumination
- poker chip
- tiny hardware nodes
- count accents
- advertisement highlight

Do NOT:

- outline everything bright blue
- fill every button blue
- make all text blue
- create giant glows

The screen remains predominantly BLACK and GUNMETAL.

## ================================================== 27. DEPTH AND LIGHTING

Use multiple depth cues:

- contact shadow
- inset shadow
- subtle bevel
- chrome edge reflection
- blue light spill
- black-glass reflection
- inner recess
- panel separation

Animations should remain subtle.

Hover:
slightly brighter local blue illumination.

Pressed:
control appears physically depressed.

Selected:
controlled energy seam strengthens.

Avoid exaggerated movement.

## ================================================== 28. TYPOGRAPHY TOKENS

Create or reuse centralized design tokens.

Conceptual examples:

--casino-display-font: "Cinzel";
--casino-ui-font: "Inter";

--casino-black-1000: #030405;
--casino-black-950: #07090c;
--casino-black-900: #0c0f13;

--casino-gunmetal-900: #171b20;
--casino-gunmetal-800: #22282e;
--casino-gunmetal-700: #30373e;

--casino-chrome-highlight: #f1f3f5;
--casino-chrome-light: #d7dbdf;
--casino-chrome-mid: #a9afb5;
--casino-chrome-dark: #353b41;

--casino-blue-core: #168fff;
--casino-blue-bright: #42b9ff;
--casino-blue-glow: #00a8ff;

--casino-green: #2fcf71;
--casino-gold: #d7a72b;
--casino-red: #d84343;

Use existing project variables when equivalent.

Do not create uncontrolled hardcoded colors throughout the screen.

## ================================================== 29. RESPONSIVE / MOBILE-FIRST REQUIREMENTS

The approved reference is a desktop presentation, but implementation must remain mobile capable.

Test at minimum:

320px
375px
390px
430px
768px
1024px
1440px

On narrow mobile:

Welcome header remains centered.

SHARK CLUB scales down cleanly.

Filter groups may horizontally scroll or use an intentional compact layout.

Advertisement remains readable and does not crush vertically.

Tournament list may switch into a mobile row/card representation if the existing product already supports that.

Do not destroy existing mobile behavior merely to imitate the desktop reference.

## ================================================== 30. ACCESSIBILITY

Preserve semantic controls.

Use real:

button
table / grid semantics
links
labels

where appropriate.

Maintain:

- keyboard navigation
- visible focus states
- ARIA labels
- touch target size
- screen-reader labels
- disabled semantics
- loading semantics
- sufficient contrast
- prefers-reduced-motion support

Do not bake dynamic text into inaccessible images.

## ================================================== 31. DYNAMIC CONTENT

Keep dynamic:

154 Games
Tournament names
Times
Game type
Buy-in
Guarantee
Registered counts
Tournament status
Countdowns
Advertisement content
Current selections
Active filters

Do not rasterize these values.

## ================================================== 32. PERFORMANCE

Optimize decorative assets.

Prefer:

- reusable WebP/AVIF images
- CSS only for lightweight structural effects
- shared background assets
- lazy-loaded advertisement imagery where appropriate
- no unnecessary rerender of static decorative hardware when data changes

Avoid dozens of giant transparent PNGs if smaller optimized assets or reusable frame components can preserve visual quality.

## ================================================== 33. BUILD ORDER

Perform implementation in this order:

PHASE 1
Audit current component and functionality.

PHASE 2
Create safe feature branch.

PHASE 3
Build master outer frame.

PHASE 4
Build Welcome Header.

PHASE 5
Restyle Find Your Game console.

PHASE 6
Create advertisement slot.

PHASE 7
Restyle tournament ledger.

PHASE 8
Build status badges and game-type tags.

PHASE 9
Add bottom poker-chip medallion.

PHASE 10
Responsive/mobile refinement.

PHASE 11
Accessibility check.

PHASE 12
Functional regression test.

PHASE 13
Rendered visual comparison to attached reference.

## ================================================== 34. VISUAL QA

Do not approve based solely on source code.

Run the actual page.

Compare directly against the attached approved reference.

Check:

- Outer-frame silhouette
- Chrome quality
- Black texture
- Header proportions
- Shark Club typography
- Blue subtitle
- Filter spacing
- Active states
- Advertisement placement
- Advertisement framing
- Tournament ledger density
- Row spacing
- Status badges
- Column alignment
- Bottom poker chip
- Overall visual weight

The result should clearly look like the attached reference.

## ================================================== 35. FUNCTIONAL QA

Verify:

- All filter buttons work
- Selected states work
- Tournament rows work
- Sorting works
- Registration navigation works
- Dynamic data loads
- Status changes correctly
- Counts remain live
- Advertisement interaction works
- Responsive behavior works
- Loading states work
- Error states work
- Existing routes remain intact

## ================================================== 36. IMPORTANT RESTRICTIONS

DO NOT:

- touch live poker gameplay
- touch World Hub
- touch Club Commander
- replace APIs
- hardcode server values
- simplify this into generic CSS cards
- remove existing functionality
- use a shark icon in the top header
- use a shark/fish icon as the lower center medallion
- duplicate the Welcome To The Shark Club banner at the bottom
- create multiple disconnected exterior frames

## ================================================== 37. DEFINITION OF DONE

This assignment is complete only when:

1. The screen uses ONE cohesive master outer frame.

2. The welcome header is integrated at the top.

3. The shark icon has been removed from the top header.

4. Find Your Game sits immediately beneath the header.

5. The advertisement slot sits between Find Your Game and the tournament display.

6. The tournament display is integrated into the same hardware chassis.

7. The old separate bottom welcome banner is removed.

8. A premium poker-chip medallion occupies the lower-center frame position.

9. Existing live tournament data still works.

10. Existing filters still work.

11. Existing sorting still works.

12. Existing navigation still works.

13. Mobile layouts remain functional.

14. No live gameplay screens were changed.

15. The rendered result visually matches the approved Smarter.Poker casino reference.

---

## FINAL COMMAND

Begin by auditing the existing Shark Club tournament/schedule page and identify the minimum safe component boundaries necessary to recreate the approved reference.

Preserve all existing business logic.

Build the screen as ONE premium casino-machine interface using the attached reference as the visual authority.

Do not stop at a loose approximation.

Run the page, visually compare it to the reference, refine it, and verify functionality before considering the task complete.
