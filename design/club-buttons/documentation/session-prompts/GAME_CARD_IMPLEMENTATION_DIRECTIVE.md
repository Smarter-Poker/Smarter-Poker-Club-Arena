# ================================================================

# MASTER IMPLEMENTATION DIRECTIVE

# CLUB ARENA DYNAMIC SHARK CLUB GAME CARD SYSTEM

# DESKTOP + MOBILE

# ================================================================

You are implementing a new production-grade dynamic game-card system
inside SMARTER.POKER CLUB ARENA.

This is NOT a request to redesign the application.

This is NOT permission to rewrite existing poker logic.

This is NOT permission to replace working realtime data systems.

This is NOT permission to generate generic CSS approximations of the
approved artwork.

The approved visual references I provide are the source of truth.

Your responsibility is to take those approved card designs and turn them
into reusable, responsive, data-driven production components while
preserving all existing Club Arena functionality.

The result must support dynamically generated cards for:

1. MTT / TOURNAMENT
2. NLH CASH
3. PLO / PLO4 / PLO5 / PLO6 / PLO8
4. SPINS
5. HEADS UP

Each family must have:

DESKTOP TEMPLATE +
MOBILE TEMPLATE +
LIVE DATA BINDING +
STATUS STATES +
ACTION HANDLERS +
ACCESSIBILITY +
RESPONSIVE BEHAVIOR

---

1. PRIMARY ARCHITECTURAL PRINCIPLE
   \===============================================================

THE APPROVED ARTWORK IS THE HARDWARE.

THE APPLICATION DATA IS THE LIVE DISPLAY.

THE EXISTING CLUB ARENA CODE IS THE BRAIN.

Do not recreate the approved metallic artwork with generic CSS.

Use the approved card imagery as production assets wherever technically
appropriate.

The intended component model is:

APPROVED SHARK CLUB CARD ART +
LIVE DATA LAYERS +
LIVE STATUS LAYERS +
REAL SEMANTIC BUTTONS +
EXISTING CLUB ARENA HANDLERS
\=
PRODUCTION GAME CARD

## =============================================================== 2. CRITICAL TEMPLATE RULE

DO NOT CREATE A NEW IMAGE FOR EVERY GAME.

A card must be a reusable TEMPLATE.

For example, a single NLH cash-game template must be capable of showing:

NLH 1/2
NLH 2/5
NLH 5/10
NLH 10/25
NLH 25/50
NLH 50/100

and any other stakes supplied by application data.

Likewise, the same card family must dynamically support:

different player counts
different buy-ins
different table names
different rules
different statuses
different waitlists
different availability
different club settings

Do not couple the card artwork to example values shown in the reference.

## =============================================================== 3. STATIC VS DYNAMIC CONTENT

Anything that NEVER changes for that template may be part of the
pre-rendered artwork.

Examples:

STARTING TIME
BUY-IN
GUARANTEE
REGISTERED
STARTING STACK
CURRENT LEVEL
STAKES
PLAYERS
BLIND LEVELS
FORMAT
MAX PAYOUT

Permanent icons associated with those labels may also be part of the
approved artwork.

Anything that CAN change must remain live DOM content.

Dynamic examples include:

Tournament name
Table name
Game type
Stakes
Player count
Maximum players
Buy-in
Buy-in range
Guarantee
Registered count
Starting time
Start countdown
Starting stack
Current level
Current blinds
Late-registration timer
Waitlist size
Max payout
Top prize
Blind duration
Format
Status
Rules
Game subtype
Satellite target
Bomb Pot label
Insurance
Run It Twice
Straddle
Other game-specific rules

NO SERVER-FED VALUE MAY BE BAKED INTO THE PRODUCTION ART.

## =============================================================== 4. BUILD FIVE CARD ENGINES

Create five reusable component families.

Suggested conceptual names:

ArenaMTTCard
ArenaCashCard
ArenaPLOCard
ArenaSpinCard
ArenaHeadsUpCard

If the repository already has a more appropriate naming convention,
follow it.

Do not create unnecessary duplicate implementations.

## =============================================================== 5. MTT / TOURNAMENT CARD

The MTT card must dynamically support at minimum:

tournamentName
gameType
guarantee
startTime
startsIn
registrationStatus
isFeatured
isRegistered
buyIn
registeredPlayers
maxPlayers if applicable
startingStack
currentLevel
smallBlind
bigBlind
lateRegistrationRemaining
rebuyEnabled
addOnEnabled
satellite
bounty
pko
mysteryBounty
turbo
deepStack
other tournament rules

Primary actions may include:

Details
Register
Registered
Late Register
Unregister
Enter Table
Watch Table

The component must determine which actions are appropriate from existing
application state.

DO NOT invent new tournament logic.

## =============================================================== 6. NLH CASH GAME CARD

The NLH cash-game card must dynamically support:

tableName
gameType
smallBlind
bigBlind
players
maxPlayers
minimumBuyIn
maximumBuyIn
status
waitlistCount
tableNumber
rules
insurance
runItTwice
straddle
bombPot
anonymous
private
featured
other existing rule flags

Example visual output may resemble:

NLH 25/50

Insurance Test

STAKES
25/50

PLAYERS
3/6

BUY-IN
2,000 - 10,000

But all those values must come from real application data.

Primary actions:

View Table
Join Table
Join Waitlist
Leave Waitlist

Use existing application eligibility and seat logic.

## =============================================================== 7. PLO CARD FAMILY

Do not build separate codebases for:

PLO
PLO4
PLO5
PLO6
PLO8

Build one PLO-family component that receives its subtype dynamically.

Examples:

gameVariant = "PLO"
gameVariant = "PLO5"
gameVariant = "PLO6"
gameVariant = "PLO8"

The card must dynamically support:

tableName
tableNumber
gameVariant
stakes
players
maxPlayers
buyInMin
buyInMax
status
waitlist
rules
bombPot
doubleBoard
tripleBoard
runItTwice
insurance
straddle
other PLO rule flags

The PLO family may use the approved PLO-specific visual template while
preserving the same Shark Club manufacturing language.

## =============================================================== 8. SPINS CARD

Spins require a specialized template because MAX PAYOUT is a primary
piece of information.

Support:

name
gameVariant
buyIn
maxMultiplier
maxPayout
topPrize
registeredPlayers
maxPlayers
startingStack
blindLevels
format
status
100xLive or equivalent promotional state
other spin configuration

Example:

50 Chip Spin PLO5

100x Live

BUY-IN
50

MAX PAYOUT
Win Up To 100x
Top Prize 5,000

REGISTERED
2/3

STARTING STACK
300

BLIND LEVELS
3 Min

FORMAT
Turbo

SIT DOWN

All values remain dynamic.

## =============================================================== 9. HEADS UP CARD

Heads Up must dynamically support:

name
gameVariant
buyIn
registeredPlayers
maximumPlayers
startingStack
blindLevels
format
status
openSeats
turbo
deepstack
other heads-up configuration

Example:

NLH Heads-Up 1

BUY-IN
1

REGISTERED
1/2

STARTING STACK
1,000

BLIND LEVELS
3 Min

FORMAT
Deepstack

SIT DOWN

Again, these are example values only.

## =============================================================== 10. ONE NORMALIZED CARD DATA MODEL

Create a normalized data model so cards are not manually assembled on
every page.

A conceptual model may resemble:

type ArenaGameFamily =
| "mtt"
| "nlh"
| "plo"
| "spin"
| "heads-up";

type ArenaGameStatus =
| "open"
| "running"
| "filling"
| "registering"
| "late-reg"
| "full"
| "waitlist"
| "closed"
| "starting"
| "paused";

interface ArenaGameCardData {
id: string;
family: ArenaGameFamily;

title: string;
subtitle?: string;

gameType?: string;
gameVariant?: string;

stakes?: {
smallBlind?: number | string;
bigBlind?: number | string;
display?: string;
};

players?: {
current: number;
max?: number;
};

buyIn?: {
amount?: number;
min?: number;
max?: number;
currency?: string;
display?: string;
};

tournament?: {
guarantee?: number | string;
registered?: number;
maxPlayers?: number;
startingStack?: number;
currentLevel?: number;
blinds?: string;
startTime?: string;
startsIn?: string;
lateRegRemaining?: string;
};

spin?: {
multiplier?: string;
maxPayout?: number | string;
topPrize?: number | string;
blindLevels?: string;
format?: string;
};

status: ArenaGameStatus;

waitlistCount?: number;

rules?: ArenaGameRule[];

flags?: {
featured?: boolean;
registered?: boolean;
satellite?: boolean;
freeroll?: boolean;
pko?: boolean;
mysteryBounty?: boolean;
turbo?: boolean;
deepstack?: boolean;
bombPot?: boolean;
doubleBoard?: boolean;
tripleBoard?: boolean;
insurance?: boolean;
runItTwice?: boolean;
straddle?: boolean;
};

actions: ArenaGameCardAction[];
}

Use existing repository types and domain models where possible.

Do not duplicate data types unnecessarily.

## =============================================================== 11. TEMPLATE REGISTRY

Create a central template registry.

Conceptually:

const GAME_CARD_TEMPLATES = {
mtt: {...},
nlh: {...},
plo: {...},
spin: {...},
headsUp: {...},
};

Each entry should define:

desktop artwork
mobile artwork
dynamic text zones
status zones
action zones
rule/badge zones
preferred aspect ratio
minimum dimensions
responsive switching rules

The UI should be able to resolve:

game family +
viewport +
state
=

correct card presentation

## =============================================================== 12. DESKTOP AND MOBILE MUST BE SEPARATE COMPOSITIONS

DO NOT simply shrink the desktop card.

The approved mobile references are distinct compositions.

Use responsive template selection.

Conceptually:

if mobile:
use mobile card layout
else:
use desktop card layout

Suggested breakpoints should follow the repository's existing system,
but validate at:

320px
375px
390px
430px
768px
1024px
1440px

The mobile version must:

remain readable
avoid horizontal scrolling
retain minimum touch targets
avoid microscopic text
reflow data logically
preserve the premium Shark Club appearance

## =============================================================== 13. MOBILE CONTENT PRIORITY

When mobile space becomes constrained, preserve information in this
priority:

1. Game / tournament name
2. Game type
3. Stakes or buy-in
4. Player/registered count
5. Status
6. Primary action
7. Major financial value
8. Important rule/status indicators
9. Secondary information

Decoration must yield before essential data.

## =============================================================== 14. DYNAMIC DATA ZONES

Do not position values by random magic numbers on every component.

Create defined zones.

Conceptually:

titleZone
subtitleZone
gameTypeZone
stakesZone
playersZone
buyInZone
guaranteeZone
registeredZone
startingStackZone
levelZone
statusZone
rulesZone
primaryActionZone
secondaryActionZone

Each template should describe the placement and constraints of those
zones.

This gives us the ability to swap artwork later without rewriting game
logic.

## =============================================================== 15. TEMPLATE SWAPPING MUST BE EASY

This is mandatory.

I want to be able to replace:

mtt-card-v1.webp

with:

mtt-card-v2.webp

without rebuilding tournament logic.

Separate:

DATA
from
VISUAL TEMPLATE.

The game card logic must not depend on one exact background image.

Build adapters/configuration so the visual shell can be changed safely.

## =============================================================== 16. CARD SKINS / FUTURE VARIANTS

Prepare the architecture so future skins can exist.

Example:

template="shark-club"
template="club-jaqk"
template="midway-union"

DO NOT build those additional skins now unless they already exist.

Just ensure the component architecture does not hard-code Shark Club
into unrelated game logic.

## =============================================================== 17. STATUS PRESENTATION

Support visual status modules for:

Running
Filling
Registering
Late Reg
Full
Waitlist
Open Seats
Starting
Closed
Registered

These may use approved state artwork or tightly controlled overlay
styles.

Color rules:

BLUE
normal active / registering / running / selected

GREEN
positive / registered / available

GOLD
featured / reward / late registration where approved

RED
full / destructive / unavailable only where appropriate

Do not change the exterior chrome frame to red or green.

State color should stay primarily inside the designated status module.

## =============================================================== 18. RULE BADGES

Rules must not make the card explode in size.

Create compact rule badges or chips for things like:

Bomb Pot
Double Board
Triple Board
Run It Twice
Insurance
Straddle
PKO
Mystery Bounty
Turbo
Deep Stack
Satellite
Freeroll

Only show applicable rules.

Support overflow gracefully.

For example:

first 2 to 4 important badges visible +
"More Rules" or expandable details

Do not attempt to fit 12 labels across a narrow mobile card.

## =============================================================== 19. ACTION BUTTONS

Buttons must preserve all existing application functionality.

Possible actions include:

Details
Register
Registered
Unregister
Late Register
Enter Table
View Table
Join Table
Join Waitlist
Leave Waitlist
Sit Down
Watch Table

Do not implement duplicate business logic in the visual card.

Existing application action handler
↓
Card receives handler
↓
Real semantic button invokes handler

## =============================================================== 20. BUTTON SEMANTICS

The visible artwork may be highly graphical, but interaction must still
use semantic HTML controls.

Use actual:

<button>
<a>

where appropriate.

Ensure:

keyboard access
focus handling
disabled handling
loading handling
ARIA labels
minimum touch targets

Minimum target:

44 x 44 CSS px

Preferred mobile target:

48 x 48 CSS px

## =============================================================== 21. REALTIME DATA

These cards must update from the existing Club Arena data systems.

Potential existing sources include:

Supabase
WebSockets
Realtime channels
Tournament engine
Cash-table state
React Query
application state
server APIs

AUDIT THE EXISTING CODE FIRST.

Do not create a second realtime data pipeline.

Correct architecture:

EXISTING DATA SOURCE
↓
EXISTING STATE / QUERY
↓
NORMALIZER / FORMATTER
↓
ARENA GAME CARD
↓
LIVE DOM VALUE

## =============================================================== 22. DO NOT PUT BUSINESS LOGIC INSIDE ART COMPONENTS

The visual card should not decide:

whether the user can register
whether the user can join
whether a seat exists
whether late registration is valid
whether a buy-in is permitted
whether a waitlist is required

Those decisions belong to existing domain logic.

The card only renders the state and invokes supplied handlers.

## =============================================================== 23. NUMBER FORMATTING

Use consistent formatters.

Examples:

200
1,000
20,000 GTD
2,000 - 10,000
3/6
25/50
0.50/1
$200
$1,000 GTD

Use:

font-variant-numeric: tabular-nums;

where useful.

Never allow long values to destroy the layout.

## =============================================================== 24. STRESS TEST VALUES

Test at minimum:

STAKES

0.01/0.02
0.50/1
1/2
5/10
25/50
100/200
1,000/2,000

PLAYER COUNTS

1/2
2/3
3/6
6/9
8/8
150/500
1,250

BUY-IN

FREE
1
50
200
2,000 - 10,000
100,000 - 1,000,000

GUARANTEE

100 GTD
20,000 GTD
$1,000,000 GTD

TOURNAMENT NAME

short
medium
very long tournament names

No clipping.

No overflow outside the card.

## =============================================================== 25. LONG TITLE HANDLING

Tournament and game names may be long.

Implement:

responsive font sizing within controlled limits
line clamping where appropriate
two-line maximum on mobile
ellipsis only as final fallback
full title via accessible label / detail surface

Do not shrink text until it becomes unreadable.

## =============================================================== 26. ARTWORK ASSETS

Create a dedicated production directory for approved game-card assets.

Conceptual example:

/assets/club-arena/game-cards/
/mtt/
desktop.webp
mobile.webp

/nlh/
desktop.webp
mobile.webp

/plo/
desktop.webp
mobile.webp

/spins/
desktop.webp
mobile.webp

/heads-up/
desktop.webp
mobile.webp

Do not randomly scatter these assets across the repository.

If the repo has an established asset directory, follow it.

## =============================================================== 27. ASSET QUALITY

Use high-resolution optimized WebP or PNG where appropriate.

Do not excessively compress the chrome, brushed-metal texture, black
glass, or blue illumination.

At the same time:

avoid shipping unnecessarily giant originals
use appropriate source sizes
use responsive image handling
preload only when useful
cache static card shells

## =============================================================== 28. PERFORMANCE ARCHITECTURE

A lobby may display MANY cards simultaneously.

Therefore:

Do not rerender static artwork unnecessarily.

Memoize expensive derived values where useful.

Use stable keys.

Avoid redundant requests.

Consider virtualization if the existing lobby already needs it.

Do not add continuous GPU-heavy animation to every card.

Blue illumination should mostly be static or low-cost.

## =============================================================== 29. HOVER / PRESSED / SELECTED

Desktop hover:

subtle lift
slightly brighter chrome
slightly stronger blue seam
no giant glow cloud

Pressed:

minor inset movement
darker glass
less specular highlight

Selected:

brighter internal blue seam
possibly subtle blue glass tint

Mobile must not depend on hover.

## =============================================================== 30. CARD FAMILY VISUAL PERSONALITY

All cards belong to the same Shark Club manufacturing family but must
not all be identical.

Use:

MTT
Premium tournament plaque.

NLH
Compact casino table module.

PLO
Omaha-oriented table module with appropriate PLO identity.

SPINS
Prize-machine cartridge with Max Payout as the visual hero.

HEADS UP
Symmetrical duel/challenge card.

The system principle is:

SAME FACTORY.
DIFFERENT MACHINES.

## =============================================================== 31. DO NOT REPEAT THE PREVIOUS GENERIC-FRAME MISTAKE

Do NOT build:

one generic rectangle +
different title +
different icon

The five families must preserve the approved distinct compositions.

## =============================================================== 32. DO NOT TOUCH LIVE POKER GAMEPLAY

This assignment applies to LOBBY / GAME DISCOVERY CARDS.

Do NOT modify:

TablePage
live table UI
hole cards
community cards
seat geometry
pot
action buttons inside actual gameplay
gameplay animations
gameplay utility controls

This is not the gameplay migration.

## =============================================================== 33. EXISTING CARD AUDIT

Before implementing:

Find the current:

MTT cards
NLH cash cards
PLO cash cards
Spins cards
Heads Up cards

Document:

source component
data source
props
status rules
actions
responsive behavior
handlers

Create a mapping:

CURRENT CARD
→
NEW ARENA TEMPLATE

Do not ask me to locate all five manually.

Audit the repository.

## =============================================================== 34. FIRST IMPLEMENTATION PHASE

Implement one family at a time.

Recommended order:

1. NLH
2. PLO
3. MTT
4. Spins
5. Heads Up

After each family:

run tests
open lobby
inspect desktop
inspect mobile
verify handlers
verify realtime changes
verify state changes

Then proceed.

## =============================================================== 35. VISUAL QA BREAKPOINTS

Validate rendered cards at:

320
375
390
430
768
1024
1440

For mobile specifically verify:

no horizontal page scrolling
no clipped chrome
no cut-off corners
no truncated action buttons
no unreadable type
no overlap
no broken long monetary values
no cramped rule badges

## =============================================================== 36. FUNCTIONAL QA

Test:

Register
Unregister
Late Register
Details
View Table
Join Table
Join Waitlist
Leave Waitlist
Sit Down

where applicable.

Test state transitions:

Open → Full

Open → Waitlist

Filling → Running

Registering → Registered

Registering → Late Reg

Starting → Running

Make sure the correct artwork/status changes without remounting unrelated
application systems.

## =============================================================== 37. TEMPLATE DEVELOPMENT PAGE

Create or extend a private development showcase for the five cards.

Conceptually:

/dev/game-cards

Display:

MTT desktop
MTT mobile

NLH desktop
NLH mobile

PLO desktop
PLO mobile

Spins desktop
Spins mobile

Heads Up desktop
Heads Up mobile

Provide local mock-data selectors ONLY on this development page for:

stakes
players
buy-in
status
game variant
rules
waitlist
long titles

This allows visual testing without altering production data.

## =============================================================== 38. DO NOT HARDCODE SHARK CLUB DATA

The references may contain example content such as:

Sunday $200 Deep Stack

NLH 25/50

PLO8 1/2

50 Chip Spin PLO5

NLH Heads-Up 1

These are EXAMPLES ONLY.

Production cards must display whatever game information the backend
supplies.

## =============================================================== 39. DO NOT PUT CLUB-SPECIFIC TEXT INTO GENERIC CARD LOGIC

The visual theme may currently be Shark Club.

The game card engine should remain capable of rendering another club's
games using the same template.

Do not hardcode:

Shark Club

into card data components unless it is genuinely part of a supplied club
record.

## =============================================================== 40. DEFAULT CARD RESOLUTION LOGIC

Conceptually:

resolveGameCardTemplate({
family,
viewport,
state,
skin
})

returns:

visual asset
layout configuration
data-zone configuration
status configuration

Do not scatter viewport and family conditionals throughout random JSX.

## =============================================================== 41. CENTRAL FORMATTER LAYER

Create or reuse utility formatters for:

currency
stakes
players
guarantees
timers
registration counts
buy-in ranges
levels
blinds

Do not format those independently in five components.

## =============================================================== 42. ERROR / LOADING STATES

Cards must support:

loading
loaded
updating
error
stale
offline

If a value is unavailable:

do not fake zero.

Example:

Unknown players does NOT automatically equal:

0/9

Use the existing application's unavailable state.

## =============================================================== 43. DATA UPDATE WITHOUT ARTWORK FLASH

When:

3/6 becomes 4/6

or:

25/50 becomes 50/100

the static card artwork must remain mounted.

Only the live data layer should update.

Avoid image flicker.

## =============================================================== 44. CARD CLICK BEHAVIOR

Do not make the entire card clickable if doing so creates conflicts with
internal buttons unless the existing product intentionally works that
way.

Maintain clear interaction hierarchy.

If the entire card opens details:

ensure nested buttons do not trigger the card click accidentally.

## =============================================================== 45. ACCESSIBILITY

Card artwork is decorative.

Do not expose massive decorative artwork descriptions to screen readers.

Expose the meaningful game information semantically.

Example accessible summary:

"NLH 25/50, 3 of 6 players, buy-in 2,000 to 10,000, running."

Buttons need explicit labels.

## =============================================================== 46. ACCEPTANCE CRITERIA

This migration is complete only when:

All five families exist.

All five have desktop templates.

All five have mobile templates.

All five accept live data.

Different stakes can render from one template.

Different player counts can render from one template.

Different buy-ins can render from one template.

Different rules can render from one template.

Different statuses can render from one template.

Existing actions still work.

Existing realtime data still works.

The artwork can later be swapped without rewriting business logic.

Mobile layouts are production-ready.

No live poker gameplay has been modified.

## =============================================================== 47. FINAL REPORT

At completion return:

1. Components created.
2. Existing components migrated.
3. Asset directories.
4. Template registry location.
5. Normalized data adapter location.
6. Data sources preserved.
7. Action handlers preserved.
8. Desktop widths tested.
9. Mobile widths tested.
10. Status states tested.
11. Long-value stress tests.
12. Rule combinations tested.
13. Remaining legacy game cards.
14. Any intentionally excluded surfaces.
15. Confirmation live gameplay was not changed.

## =============================================================== 48. CONTINUOUS EXECUTION

Treat this as one controlled assignment.

Do not stop after implementing only one example card.

Proceed through:

AUDIT
↓
DATA NORMALIZATION
↓
TEMPLATE REGISTRY
↓
NLH
↓
PLO
↓
MTT
↓
SPINS
↓
HEADS UP
↓
DESKTOP QA
↓
MOBILE QA
↓
FUNCTIONAL QA
↓
REALTIME QA
↓
FINAL LEGACY CARD AUDIT

Only stop for a genuine blocker.

Do not stop simply because a component needs a new reusable variant.

---

## FINAL COMMAND

Audit the current Club Arena game-card architecture first.

Then turn the approved Shark Club desktop and mobile card artwork into a
reusable dynamic game-card template system.

Do not recreate individual cards manually for every game.

Build reusable visual templates whose live data zones can display any
valid:

game name
game type
stakes
players
buy-in
guarantee
registration count
rules
status
timers
payouts
format

provided by Club Arena.

Preserve every existing handler and data connection.

The finished system should make adding a new game as simple as supplying
new game data to the appropriate card family, not designing or coding a
new card.
