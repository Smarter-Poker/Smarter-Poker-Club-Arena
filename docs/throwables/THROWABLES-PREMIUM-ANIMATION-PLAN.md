# Throwables: the premium animation programme

2026-09-06. Dan, verbatim: "CURRENTLY THEY ARE JUST EMOJI'S THAT DON'T DO
ANYTHING, WE NEED TO ADD IN THE FULL FRAME BY FRAME ANIMATION FOR EACH AND
EVERY SINGLE ONE, AS WELL AS CREATE SOME NEW 'VIP ONLY' AND SOME PURCHASEABLE
ONES ONLY ... CREATE A COMPREHENSIVE UPGRADE AND ENHANCEMENT BUILDING PLAN TO
TURN EACH OF OUR STATIC THROWABLES INTO TRUE, PREMIUM FULLY ANIMATED
THROWABLES." And: "you need to categorize ours as well, we have throwables that
you need to audit, improve and enhance as well as add any and all new ones as
you see fit."

Everything in this document is measured, not remembered. The two PokerBros
captures (`PB THROWABLE 1.MOV`, 90 s; `PB THROWABLE 2.MOV`, 130 s) were pulled
apart at 30 fps, every throw located by per-seat frame differencing, every beat
timed to the frame, and every sound cue measured off the audio track (RMS per
video frame, onset frames, spectral centroid). The full frame-by-frame
catalogues are beside this file:

- `docs/throwables/pokerbros-reference-video-1.md` (12 hero throws, 1 incoming)
- `docs/throwables/pokerbros-reference-video-2.md` (18 hero throws, 1 incoming)

Thirty-one throws, 31 distinct items observed in motion, and the complete
picker inventory (26 character items, 5 VIP-badged, 14 emoticons, 2 locked
"Special"). Our own 49 were read from `ThrowableService.ts`,
`ThrowAnimation.tsx/.css`, `ThrowableSignatures.css`, `ThrowableSoundService`,
`ThrowableVoice`, `ThrowableSelector`, `fn_use_throwable` (live definition) and
`throw_usage` (live rows).

---

## 0. The verdict in one page

**What the reference is.** A PokerBros throwable is a short bespoke cartoon:
a hand-animated character or object that flies in a straight line in a third
of a second and then PERFORMS on the target's chair for about four seconds.
Two beer mugs land, a second one pops in, they swing together, clink, spray
foam, and rest. A trash can lands, vanishes, a 2 and a 7 pop out, a swear
bubble appears, the can comes back, opens its lid, eats the cards, closes, and
flies buzz around it. A rat flies over, pops onto the face, winks, pulls a
face-down card out of its mouth, flips it to the ace of spades, and laughs.
Each one has a designed sound (a cork pop, a cash register, a donkey bray, a
crowd cheer) timed to the beat it belongs to. The projectile is a footnote;
the payload is the product.

**What ours is.** One still 3D render per item, a runtime alpha cutout, and a
generic motion grammar: windup, one of seven CSS flight curves (arc, lob,
spiral, swoop...), a squash on landing, a shockwave ring, a particle scatter, a
stain, plus per-item CSS decorations (streaks, rings, glows) and a procedural
Web Audio recipe with a `speechSynthesis` voice line. The framework is
sophisticated (contact shadow, speed-proportional smear, settle, speed law,
multi-table scoping, atomic RPC) and it was built well. It is also the ceiling:
a still image cannot clink, pour, wink, peck, bray or cry, so every item is
the same sticker doing the same squash with a different colour of confetti.
That is what Dan is seeing when he says "emojis that don't do anything".

**What has to change.** Not the plumbing. The ASSET FORMAT and the GRAMMAR:

1. Every throwable becomes a rigged, multi-layer, timeline-driven animation
   (Lottie / bodymovin JSON, exported from After Effects or authored in
   LottieFiles), with a spec file that names its beats, so the projectile,
   the payload performance, the residue and the sound cues are one scripted
   sequence per item, not a physics profile times an impact profile.
2. The grammar follows the reference: spawn on the thrower's avatar, straight
   constant-speed flight of ~300 ms, blink-and-pop arrival with a damped
   bounce, payload drawn OVER the avatar at 1.0-1.5 avatar widths, ~4.5 s of
   performance, hard cut. Arcs, lobs and tumbles go.
3. Sound becomes a designed sample library (recorded / licensed / produced),
   one AudioBuffer per cue, scheduled on the AudioContext clock on the beat
   the spec names. Procedural oscillators and TTS voices are retired.
4. An entitlement model: a catalogue table with tiers (free / VIP / premium),
   per-user ownership for purchasable items, locks and badges in the picker,
   and an RPC that refuses a throw the sender is not entitled to. Today the
   "VIP" tab is a label: `fn_use_throwable` never looks at the item id.
5. The catalogue grows: our 48 stay (rebuilt; the service header says 49,
   the list holds 48), the reference's 15 items we lack are added (rat, donkey, fish, and the 14-emoticon set plus the two
   locked "Special" ones as our own designs), and 16 new VIP-only and
   purchasable premium items are designed for us.

The rest of this document is the measured reference (section 1), the audit of
ours (section 2), the target architecture (section 3), the per-item build
sheets for all 48 + 15 + 12 (+4 seasonal) (section 4), the phased plan (section 5), and the
decisions that are Dan's (section 6).

---

## 1. The reference, measured

### 1.1 The grammar every PokerBros throwable shares

Thirty-one throws across two captures agree on this. Numbers are 30 fps frames
converted to ms; avatar diameter is ~30 px in video 1 and ~40 px in video 2, so
sizes are given in avatar widths (u).

| Beat            | Measured                                  | Notes                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Taps to throw   | 2                                         | tap the seat (PROFILE sheet opens in ~100 ms), tap a tile. The sheet closes ON the tile tap in 2-3 frames; Confirm is for the Tag field, never for a throw                                                                                                                                                                             |
| Spawn           | 100-300 ms                                | the item scales in from ~0 to full ON the thrower's avatar (upper-left of the face, or dead centre for characters/emoticons), then holds 0-5 frames. Fireworks spawn nothing at the thrower                                                                                                                                            |
| Flight          | 133-400 ms, typically 200-333             | STRAIGHT line, CONSTANT speed, ~20-25 px/frame = about one avatar width per frame. No arc, no easing, no trail, no scale change. Rotation only where the object would rotate (dice tumble; the bear wobbles a few degrees)                                                                                                             |
| Arrival         | 67-200 ms                                 | "blink and pop": the sprite collapses to a dot or blinks out for 1-3 frames, then re-grows from the target centre with a damped bounce (overshoot 1.1-1.5x, one undershoot, settle in 4-8 frames). Objects that must stay upright (bottle, mug, trophy) simply arrive and overshoot 1.1x                                               |
| Payload         | 1.0-1.5 u; bursts 2.0-2.4 u               | drawn OVER the avatar, never under. Characters and emoticons REPLACE the face (0.9-1.05 u). The name plate, stack and action badge stay visible                                                                                                                                                                                        |
| Avatar reaction | none                                      | the avatar never shakes, tints, scales or flinches. Everything happens in the overlay                                                                                                                                                                                                                                                  |
| Life            | ~4.5 s for full items; 2.0-3.3 s for gags | measured: beer 4.57, trash 4.50, bear 4.50, doge 4.37, champagne ~4.7, rat 4.3, donkey 4.0, chicken ~4.0, angry emoticon 3.9, missile 4.0; glove 2.07, clown 2.23, bomb 2.0, fireworks 3.0, fish 3.3, cash 3.6, dice hand >= 5.6                                                                                                       |
| End             | one frame                                 | hard cut. No fade, no lingering residue (the clown cloud and the fish gash fade over 8-10 frames; everything else vanishes)                                                                                                                                                                                                            |
| Audio           | tied to PAYLOAD beats                     | silence at spawn and in flight for every item; the only landing sounds are a horseshoe tick, a doge bass boom, a chicken thud, a cash thump. Sounds are 5-11 frames (170-370 ms) later than the visual beat they belong to (recording latency, not design intent; build to the visual beat) and often outlast the picture by 0.5-1.1 s |
| Counters        | "Free emojis left: N"                     | one free emoji consumed per throw; emoticons consume one too. Recently Used row (5, most recent left) fills as you throw                                                                                                                                                                                                               |

Two rhythms recur and are worth naming, because they carry most of the set:

- **Object rhythm** (gun, mug, can, bottle, bomb, egg, cake, tomato, poop,
  banana, fish): spawn -> straight flight -> land -> a 0.5-1.5 s CHOREOGRAPHED
  gag with two or three sub-beats -> a residue or rest pose -> cut.
- **Character rhythm** (doge, bear, rat, shark, donkey, chicken, every
  emoticon): spawn centred on the thrower's face -> straight flight of the
  full sprite -> blink -> pop onto the target face with overshoot -> a 3.5-4 s
  ANIMATED PERFORMANCE (idle, gesture, big moment, tail) with a looping or
  phrased sound -> cut. The face is covered the whole time.

### 1.2 The inventory (47 tiles)

**Character Emojis** (26, five per row): water gun, beer mug, fireworks, doge,
horseshoe; trash can (the 2-7 gag), red boxing glove, hand with dice, champagne
bottle + flutes, white clown/snowman; brown bear head, gold trophy, egg,
strawberry cake, missile; banana, cash bundle, rat with card, poop, tomato;
shark with knife and fork, donkey, chicken, bomb, rose; fish.

**VIP Emojis** (5, gold "V" badge): bear, cake, missile, rat, poop. These are
the same items as in the grid, gated: the badge is the tell.

**Emoticons** (14): party face with horn, blushing smile, laughing face with
raised hand, thinking face, smug OK, sleeping (nightcap + Zzz), facepalm/wink,
angry red, screaming, vomiting rainbow, loudly crying, laughing with tears,
surprised with a white flag (surrender), heart eyes.

**Special** (2, padlock badge, locked): a blue energy ball, a sloth.

No prices are shown anywhere. The VIP tier is a badge; the Special tier is a
lock. Tabs are section anchors (clock = Recently Used, box = Character, V =
VIP, smiley = Emoticons), not filters: the whole sheet scrolls.

### 1.3 Every observed throw, one line each

Full beat tables with frame numbers are in the two reference files. This is
the choreography and the sound in one line, the way a build sheet needs it.

| Item                                         | Choreography (ms from launch)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Sound                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Water gun                                    | spawn on face 0-100; straight flight 133-400; shrink to dot, pop with 1.1x overshoot 500; hold 600-733; PULL BACK down-left 767-900 (gun now aimed up at the face from below); SQUIRT 933: cyan stream + a cyan splat FACE (two white eyes) 2.0 u covering the avatar; squirt loop 933-3433 with droplet pulses every ~270 ms and +-4 px recoil; splat off 3467 (one frame); gun shrinks out by 3567                                                                                                                                                                                                                                             | none in the capture (recording started silent)                                                                                                                                                                                                        |
| Beer mug                                     | spawn 0-167; upright flight 200-500; land with 1.1x overshoot; mug 1 slides right 533-1200; MUG 2 pops in on the left 900-967; hold apart; swing inward + up 1400-1567; CLINK over the forehead 1567: white foam plume 0.8 u above the rims, 8-12 droplets; V hold 2100-2367; ease apart; rest flanking the face to 4500; cut                                                                                                                                                                                                                                                                                                                    | soft pop at mug 2's spawn; loud glass chime with ~6 rattles, 1.3 s ring-down, 370 ms after the visual clink                                                                                                                                           |
| Fireworks                                    | NOTHING at the thrower; 930 ms silent pre-delay; rocket 1 trail rises at the avatar's lower-right 0-200, BLUE burst 233-700 (0.85 u); rocket 2 at the left, MAGENTA burst 567-1067 (1.2 u); rocket 3 at the right, YELLOW->orange->ember burst 1033-1733; gap 1767-2033; wave 2: three trails together, three bursts together 2333-2567 (group 2.4 u, white-hot centre), darken and fade to 3000                                                                                                                                                                                                                                                 | rising whistle 0-830 ms peaking at burst 1; crackling bang cluster (one bang every 130-170 ms) around bursts 2-3; rumble; wave-2 barrage with the loudest hit 170 ms after the bursts open; tail outlasts the picture by 1.1 s                        |
| Doge                                         | pixel SUNGLASSES fade in ON THE THROWER'S EYES 0-167; the glasses fly 200-367 (fast, 17 px/frame) and land on the target's eyes; glasses vanish, Doge head pops from the centre with a damped bounce (7 -> 43 -> 26 -> 33 px) 400-733, 1.05 u, covers the face; hold; glasses re-enter from upper-right and slide onto the Doge's eyes 1433-1600; 16-ray YELLOW SUNBURST fades in behind 1633-1767 (2.2 u) and shimmers to 4333; cut                                                                                                                                                                                                             | deep bass boom on landing (peak on the overshoot frame, 1 s decay); silence; a 2-bar music sting at ~112 BPM (hi-hat / mid hits every 267 ms) from the sunburst on, ending 0.57 s after the cut                                                       |
| Horseshoe                                    | spawn 0-200; flight 233-400 (no spin); one soft BOB up 12 px and back 400-1000; glow bloom 1167-1433 (flat yellow silhouette 1.4x); "GOOD LUCK" text (red-orange, gold outline, italic) grows out of the glow 1467-1667 with a yellow ray burst 45-70 px; text holds 1667-3767+; four green clovers grow out of the corners 1867-2100; cut ~4500                                                                                                                                                                                                                                                                                                 | bright tick on landing; metallic clank at the bottom of the bob (400 ms later); the text and clovers are silent                                                                                                                                       |
| Trash can (2-7)                              | spawn 0-167; flight 200-467; land one frame 500; can VANISHES 533-800; card "2" pops out upper-left, rights itself, lands lower-left 833-967; "7" pops out upper-right 1000-1100; grawlix speech bubble 1267-2467; cards shift right 1833-2000; can rises back from below 1967-2100 at 1.2 u; lid opens and hovers upper-left 2200-2500; the 2 then the 7 rise, rotate, and fall into the can 2533-2967; lid closes 3000-3133; FLIES buzz at the lid 3500-4467; cut 4500                                                                                                                                                                         | two low slaps as the cards pop; faint tick at the bubble; rising rattle as the can returns; silence while it eats; metallic clank as the lid closes                                                                                                   |
| Boxing glove                                 | (ours already replaced this with the KnockoutFlurry; recorded for parity) glove spawns on the face, flies 167-467; FOUR punches on a forearm alternating L/R/L/R every 300 ms at 500, 800, 1067, 1333 with an orange star flash and 8-12 red particles each; the 4th has a jagged yellow lightning shockwave 1.5 u to the right 1600-1900; fist held 1733-2033; cut 2067                                                                                                                                                                                                                                                                         | four thwacks exactly on the flash frames, the finisher as a triple                                                                                                                                                                                    |
| Hand with dice                               | pair of dice spawn 0-100 and TUMBLE in flight 100-333 (the only rotating projectile); land, swap for a skin-tone HAND 1.3 u tall covering the left half of the face 367; loop >= 5.6 s: upright hold, dip, palm-down jiggle, low hold, shake, repeat (cycle ~1.4 s)                                                                                                                                                                                                                                                                                                                                                                              | silent until the first shake; dice-rattle clicks (6-7 kHz, 1-2 frames each) in bursts of 4-6 that follow the visible shakes only                                                                                                                      |
| Champagne                                    | bottle spawns 0-233, flies UPRIGHT 267-433; stands centred on the avatar 433-767; CORK POP 800: white puff then a foam JET 20-25 px above the neck 933; continuous jet with sideways droplets 967-1533; jet detaches into a rising thread 1567-1900; rest; bottle cross-fades into ONE FLUTE 2300-2467; second flute fades in left 2700-2967; both tilt into a V and CLINK 3167-3267 with yellow droplets; ease apart to flank the face 3267-3500; fade                                                                                                                                                                                          | CORK POP = the loudest sound in either capture (0.64 RMS), 100 ms after the puff; continuous fizz 2.2 s; glass clink 350 ms after the rims touch; two softer clinks; total ~4.7 s                                                                     |
| Clown / snowman                              | spawn 0-200; flight 233-600 straight up the centre line at exactly 24 px/frame; land 600; SPLAT 633: the figure vanishes leaving the red nose; a white powder plume grows ABOVE the head 667-767 (0.7 u wide, 1.2 u tall); specks spray; the red NOSE FALLS down the face at 1 px/frame to the chin; cartoon cloud lingers 1000-1933 with shifting lobes; fades 1967-2200                                                                                                                                                                                                                                                                        | one soft poof 170 ms after the splat; nothing else                                                                                                                                                                                                    |
| Bear                                         | spawn 0-167; LIFTS above the thrower's head then flies 200-400 with a +-10 deg wobble; shrink to dot 433-533; pop 567-667 to 1.5 u (covers the face and the badge); LAUGH loop 700-2000 (mouth works, head bobs); ANGER phase 2033-4467: red throbbing-vein mark top-right, face flushes red, shout, yellow star highlights in the eyes, tremble +-3 px; cut 4500                                                                                                                                                                                                                                                                                | rhythmic ha-ha-ha bursts every 100-130 ms from 100 ms after full size; breath; second laugh phrase; grumble wind-up; sustained ROAR 2.0 s through the anger phase, tail 0.5 s past the cut                                                            |
| Trophy                                       | spawn 0-200, lift, flies UPRIGHT 267-367 (fastest flight: 4 frames); statuette vanishes, a grey wisp rises above the shoulder 400-600; a golden-white SPOTLIGHT BEAM grows above the avatar's left side 633-1267 with the statuette forming at its base; beam fades 1300-1600; statuette stands on the shoulder with white sparkle glints to 4500                                                                                                                                                                                                                                                                                                | soft low swell under the wisp; shimmering chime at full beam; fuller fanfare as the beam fades; sustained soft shimmer with the sparkles                                                                                                              |
| Egg                                          | spawn on the hero's head 0 (-300 before launch: 130 ms scale-in, 170 ms hold); flight 367 straight up at 20 px/frame; CRACK 400: in one frame the egg becomes a yolk cap on top of the head with white drips running to the chin; residue static 2-4.6 s; cut                                                                                                                                                                                                                                                                                                                                                                                    | quiet crack/splat plus a faint tick                                                                                                                                                                                                                   |
| Cake                                         | spawn/hold 233; flight 133 (short hop to the adjacent seat); cake sits INTACT and drifts up 3 px/frame for 3 frames (a "press"); SQUASH 267: cake tips, cream spreads; the PLATE turns face-on as a white disc 0.55 u centred on the face 300 with pink/white splatter; plate SLIDES DOWN the face 1 px/frame 500-967; plate fades 1000; residue = cream smear + strawberry at the crown, static 2-4.4 s                                                                                                                                                                                                                                         | bright click on spawn; low rumble approach; MAIN SPLAT exactly on the squash frame (0.83 peak sample); smaller wet hit as the plate starts sliding                                                                                                    |
| Missile (airstrike)                          | a red CROSSHAIR fades in on the thrower's head -300..-33; flies straight up 0-300 at 21 px/frame; LOCK-ON 333-1600: reticle sits on the face and HUNTS (+-5 px slow sweep, one sweep per ~830 ms); LOCK 1633-1700: reticle scales 2x then 3.5x and fades; 430 ms of nothing; MISSILE dives in from the top screen edge 2267-2533, growing 4 -> 14 px with an exhaust flame; HIT 2567: dull red glow behind the missile; flame 2633-2700; FULL FIREBALL 2733-2833 (1.3 u wide, 50 px above the head, avatar hidden); orange with ember blotches 2867-3000; khaki MUSHROOM CLOUD 3033-3667, swelling and drifting; cloud pops out 3700; clean 3733 | four lock-on BEEPS every 533 ms from 233 ms after the reticle lands, then a doubled pair on the lock; descending MISSILE WHISTLE 0.83 s starting 170 ms before the missile is visible; EXPLOSION 0.9 s (boom + rumble) from 100 ms after the fireball |
| Banana                                       | spawn/hold; flight 100 (adjacent seat); IMPACT FLASH 133-200: yellow star-burst (white core, 5-6 rays) 0.5-0.7 u; residue: the PEEL draped over the top of the head like a hat, 40% of the face, static 2.6-5.7 s                                                                                                                                                                                                                                                                                                                                                                                                                                | 7-frame boing/splat starting 2-3 frames BEFORE the flash                                                                                                                                                                                              |
| Cash bundle                                  | spawn/hold; flight 300 straight up; the bundle OVERSHOOTS above the head 367 and FALLS BACK with ease-out 400-667 settling on the face; BURST 700-867: single bills peel off and rise; MONEY CLOUD 900-3000: 10-15 winged bills (money-with-wings) fountain in a 1.75 u cloud from the chin to 60 px above; thins 3033-3233; last bills exit up; clean 3533                                                                                                                                                                                                                                                                                      | thump when the bundle hits the head; three ticks on the settle; CASH REGISTER / coin cascade 3.3 s from the burst frame, ending 0.5 s after the last bill                                                                                             |
| Rat with card                                | spawns at the CENTRE of the thrower's face; flies as the full 0.75 u sprite 0-233; shrinks 267; INVISIBLE one frame 300; pops onto the face 333-467 to 1.05 u (covers everything, the badge peeks behind an ear); idle with tongue out; head tilt + WINK 833-900; a face-down CARD slides out of the mouth 967-1300; chews with the card held 1367-2167; card FLIPS edge-on 2300; ACE OF SPADES shown 2433-4167 while it laughs, tongue wags, head bobs; cut 4300                                                                                                                                                                                | high pop at pop-in; SQUEAK 1 (descending, 300 ms) and SQUEAK 2; high ticks as the card slides; two low gulps; hissy laugh bed; final squeak; faint pop at the cut. The whole cue spans the on-target time                                             |
| Poop                                         | spawn/hold; flight 300 straight up; contact 367; SPLAT 400: brown-orange splat 0.85 u with radial spikes and ONE droplet shooting straight up 30 px; 3-4 droplets fly out and hang 433-867; residue: the swirl on the face inside a splash ring, ~70% covered, static 2.5-5 s                                                                                                                                                                                                                                                                                                                                                                    | one wet splat 33 ms after the visual splat                                                                                                                                                                                                            |
| Tomato                                       | spawn/hold; flight 233; SQUASH frame 267 (tomato drawn flattened, semi-transparent); BURST 300: red splat 0.75-0.85 u with 6-8 chunks thrown 6-10 px; settles 467-733 with the green stem at the centre-top and drips to the chin; residue ~70% of the face, static 2.4-4.9 s                                                                                                                                                                                                                                                                                                                                                                    | one wet splat 33 ms after the burst                                                                                                                                                                                                                   |
| Shark                                        | character rhythm: spawn at the face centre, 0.6 u sprite flies 0-267 (knife in one fin, fork in the other); invisible 300; pop 333-400; OVERSHOOT 1.5x for one frame 433; settles 0.9 u 467; CHEWING loop 500-3833: jaw opens/closes every 170-200 ms, cutlery bobs, a brown morsel at the mouth; cut ~4.3 s                                                                                                                                                                                                                                                                                                                                     | near-silent bed; CHOMP at 500 ms; second chomp; then one soft tick per jaw cycle (period 170-200 ms) for the whole loop                                                                                                                               |
| Donkey                                       | character rhythm; pop with 1.3x overshoot; idle mouth/ear wiggle 633-1500; mouth opens wide (inhale) 1533-1967; BRAY 2000-3100 with teeth, head bobs, wide eyes; relax 3133-4333; cut 4367 (120 frames on target)                                                                                                                                                                                                                                                                                                                                                                                                                                | rising "hee" 470 ms; "HAW" transient; sustained bray 2.2 s starting 1.2 s after landing                                                                                                                                                               |
| Chicken                                      | character rhythm; pop 333-467; idle; PECK (head tilts down 20 deg) 867-1200; head up with bobs 1267-2267; CLUCK with the beak wide 2333-3000; half-open beak bobs to ~4.3 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | landing THUD 33 ms after the pop completes; three soft clucks 230 ms apart; loud "BAWK" 4 frames during the head-up phase; continuous clucking bed 1.8 s                                                                                              |
| Bomb                                         | spawn/hold 0.35 u with a sparking fuse; flight 233 with the spark visible; LANDS ON THE FOREHEAD and STAYS 267; FUSE phase 1.2 s: spark flickers 3-7 px, fuse shortens; pre-flash 1433 (yellow cracks in the sphere); EXPLOSION 1467: jagged yellow-orange burst 1.1 u; translucent khaki SMOKE puff 1600-1800 that thins and drifts up-left; clean 1833                                                                                                                                                                                                                                                                                         | fuse ignition fizz 170 ms after landing; faint sizzle; fizz crescendo ending on the pre-flash; BOOM 33 ms after the burst, 230 ms decay                                                                                                               |
| Rose                                         | spawn/hold; flight 300 upright; contact 333; rose INVISIBLE 367-467; a BUD appears behind the right ear 500-533 and GROWS to a full rose tilted 30 deg like a hair ornament 567-667; a pink BUTTERFLY flutters above in an 8 px loop 867-3033 (wings alternate every 2 frames); a red LIPSTICK KISS appears on the cheek 1467, grows, then DRIFTS DOWN to the chin 2633-3033; still on at 3.4 s                                                                                                                                                                                                                                                  | one soft harp/sparkle cue 1.6 s long starting 100 ms before the butterfly; the kiss is silent                                                                                                                                                         |
| Fish                                         | spawn/hold; flight 300 head-first; IMPACT FLASH 300 (the banana's star-burst); fish lies DIAGONALLY across the upper face 333; rests with a 1 px wiggle 367-1667; SLASH 1: a light blade sweeps down across it 1700-1800, spark exits top-right; SLASH 2 1967-2067; RED GASH on the fish and a red streak on the face 2167-2533; fish SLIDES DOWN the face rotating, fades in the last 3 frames 2567-3100; faint red mark fades by 3400                                                                                                                                                                                                          | the flash is SILENT; soft flop ticks every 133 ms while it lies there; SLASH WHOOSH 1 (rising, 0.16 peak); whoosh 2 with the gash; silence                                                                                                            |
| Party face (incoming, villain -> hero)       | flies as a 24 px face with a cone hat at 23 px/frame; REPLACES the hero's avatar 0.9 u; neutral 0-467; a party HORN pops out of the mouth 500; mouth opens progressively 633-1167 with purple confetti; eyes squeeze shut 1300-1567; STREAMERS (red/green/purple ribbons) fan from the horn and the hat 1567-3033+                                                                                                                                                                                                                                                                                                                               | rising party-horn toot; a bright whistle burst; a STEADY crowd-cheer / applause bed 2.5 s under the streamers                                                                                                                                         |
| Thinking face (incoming, villain -> villain) | straight flight, shrink to dot, pop with the full damped bounce (1.1 -> 1.3 -> 1.1 -> 0.8 -> 1.0); ANIMATED hold: a hand rises from the bottom-left, brows knit into a frown, hand on chin with moving eyebrows ("hmm" loop) >= 2.8 s                                                                                                                                                                                                                                                                                                                                                                                                            | a boing/pop on the bounce landing                                                                                                                                                                                                                     |
| Laughing face with hand                      | character rhythm at 18.5 px/frame; pop; smug squint with rosy cheeks 467-800; LAUGH: mouth wide with tongue, eyes squeezed, head rocks 867-~4000                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | long cartoon laugh in three ha-ha-ha swells, 4.0 s total, starting on the smug frames                                                                                                                                                                 |
| Loudly crying                                | character rhythm; pop with 1.3x overshoot; SAD phase (eyes closed, brows drooping, small "o" mouth) 467-1133; CRY 1200: in one frame the mouth opens wide, two CYAN TEAR STREAMS shoot straight down past the chin, a cyan PUDDLE spreads to 30 px at the bottom; ripple loop to ~4 s                                                                                                                                                                                                                                                                                                                                                            | sniffle; first SOB 170 ms after the tears; WAIL peaking 0.31; sobbing bed; two huge BURSTS (the loudest sound in video 2, 0.45) at 2.1 and 2.3 s                                                                                                      |
| Heart eyes                                   | character rhythm; pops HIGH (overshoot 1.4x drawn 24 px above the face) then drops onto it; SURPRISED phase (big round eyes, ":3" mouth) 633-900; eyes become PINK HEARTS 967 and GROW + pulse 1033-1433; a dark-red NOSEBLEED drip runs down over the mouth 1500; hearts keep pulsing to ~4 s                                                                                                                                                                                                                                                                                                                                                   | bright sparkle/twinkle shimmer 1.2 s from the overshoot frame (peak 100 ms before the hearts); a lower second cue after the drip                                                                                                                      |
| Angry face that catches fire                 | character rhythm at 17 px/frame with a two-frame ease-in (the slowest flight); pop high, drop; ANGRY phase 600-1600: colour ramps orange -> deep red over 1 s with a heat shimmer; shout 1667-1867; FLAMES erupt from the top of the head 1933 with an anger-star top-right; RAGE loop 1933-4200: flame flickers every frame, mouth works, head shakes; cut 4300 (118 frames on target)                                                                                                                                                                                                                                                          | low growl bed while it reddens; four roar/whooshes every 0.7 s through the flame phase; low grunt; all quiet (under 13% of full scale)                                                                                                                |

### 1.4 Spoken words, measured

Both audio tracks were run through Whisper (small.en) and every candidate
was then checked by pitch tracking (autocorrelation periodicity, F0, spectral
centroid per 30 ms) so a sound effect could not be mistaken for a voice. Two
items SPEAK; everything else is a vocalisation, a mechanical sound or a sting.

| Where                                                                                                                  | Words                                         | Measured                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Video 1, 34.74-35.16 s (horseshoe, ~600 ms after the GOOD LUCK label pops)                                             | **"Good luck"**                               | male voice, strongly voiced (periodicity 0.6-0.8), F0 137 Hz on "good" rising to 200-210 Hz on "luck", 420 ms. The video-1 reference file attributed this to a card-deal sound; that attribution is wrong and this table supersedes it |
| Video 2, 101.0-102.2 s then 102.3-104.8 s (the laughing face with the raised hand: the hand is an "L" on the forehead) | **"Ooooooh!"** then **"Loser, loser, loser"** | the "Oooh" is one sustained note, F0 232 Hz, 1.2 s; the three "loser"s are 0.8 s each at F0 120-150 Hz, male, spoken as a chant. The reference file called this "three ha-ha-ha swells"; those swells are the three words              |
| Video 2, 106.6-109.3 s (loudly crying face)                                                                            | (no words)                                    | a recorded high-pitched cartoon cry: sustained F0 340-350 Hz at periodicity 0.9, two huge bursts (the loudest sound in the capture). Whisper labelled it "_crying_"                                                                    |

Everything else in the two captures is non-verbal: the bear's laugh and roar,
the donkey's hee-haw, the chicken's bawk and clucks, the rat's squeaks and
gulps, the party face's horn and crowd, the shark's chomps, mechanical cues
(cork, cash register, clinks, lock-on beeps, missile whistle, booms) and the
doge's 2-bar beat. On screen, the only words are the horseshoe's "GOOD LUCK"
label and the trash can's grawlix bubble.

What that means for us: the reference uses NO text-to-speech and NO narrator.
Where it wants a word it records a human saying it, once, and ships the
recording; where it wants a laugh it records a laugh. Two of our seventeen
TTS lines survive as RECORDED lines ("Good luck" on the horseshoe, "Loser,
loser, loser" on the L-hand emoticon); the rest become designed sounds.

---

## 2. Ours today, audited

### 2.1 What we have

49 items in `ThrowableService.ts`, in five categories (the selector's tab
order is VIP / Toys / Sports / Party / Emoji):

| Category      | Items                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| reactions (8) | thumbs_up, thumbs_down, laughing_emoji, crying_emoji, angry_emoji, cool_sunglasses_emoji, heart, star                                              |
| throws (12)   | tomato, cracked_egg, banana_peel, pizza_slice, cake, poop, anvil, trash_can, snowman, magnet (+ water_gun and boxing_glove are filed under sports) |
| sports (9)    | water_gun, boxing_glove, basketball, football, tennis_ball, bowling_ball, horseshoe, dice, magic_8_ball                                            |
| cheers (8)    | beer, champagne, coffee, cash_stack, diamond, rose, trophy, fireworks                                                                              |
| premium (14)  | bomb, rocket, ufo, alien, robot, ghost, skull, lightning_bolt, doge, shark, bear, chicken, rubber_duck (13 listed; the file header says 14)        |

Each item is one 3D still (`images/throwables/<id>.jpg`, 300-620 KB, black or
white background) served through the Storage image transform at 192/320 px,
cut out in the browser by a border flood fill (`ThrowableCutout`), and driven
by seven fields: physics (arc / fastball / lob / float / drop / swoop /
spiral), impact (splat / splash / bounce / thud / explode / shatter / zap /
sparkle / burst), sound key, weight, linger, colours, spin. `ThrowAnimation`
plays windup 140 ms -> flight 700-1100 ms -> impact 820-1500 ms -> life to a
3.5-4.2 s total. `ThrowableSignatures.css` (2,879 lines) adds per-item CSS
decoration to 48 of the 49 (magnet 10 rules, skull 9, water_gun 8 ... bomb 2,
fireworks 2, chicken 2, banana 2). `ThrowableSoundService` synthesises every
cue from oscillators and noise; `ThrowableVoice` speaks 17 lines through
`speechSynthesis` ("Bock bock bock bock booook", "Roooaaar", "Pee yew!").
`boxing_glove` alone is bespoke: it plays the KnockoutFlurry.

The framework is good and stays: contact shadow that tracks height, speed-
proportional motion smear, ground shadow, felt dust, settle-rock, the
Animation Speed law in one place, table-scoped flinch and shake, the 4.2 s
life target, the darkroom-free harness in tests, `fn_use_throwable` with the
advisory lock, the legacy id bridge, the `[THROW:<id>:<seat>]` wire format.

### 2.2 What is wrong, ranked

**W1. One still image per item is the ceiling.** Every PokerBros item in
section 1.3 has two or more PARTS that move independently (mug and foam, can
and lid and cards and flies, rat and card, bottle and cork and jet and flutes,
glasses and Doge and sunburst, reticle and missile and fireball and cloud).
Ours has one part. No amount of CSS on one image produces a second mug that
pops in and clinks with the first. This is the whole gap and it is an asset
problem before it is a code problem.

**W2. The grammar is the opposite of the reference.** We spend 700-1100 ms
in flight on arcs, lobs, spirals and swoops with tumble spin and a smear; the
reference spends 200-400 ms on a straight line and puts every remaining
millisecond into the performance at the target. Our 4.2 s total is 25-30%
flight and 70% a sticker squashing and fading; theirs is 7% flight and 93%
show. Our arrival is a squash-and-stretch; theirs is a blink-and-pop with a
damped bounce. Our seat flinches and the table shakes; theirs never moves the
avatar. Dan's 2026-08-21 note "each throwable only lasts a split second" was
answered by lengthening the flight; the reference answer is to give the
landing something to do.

**W3. Sound is synthesised and spoken.** Every cue is an oscillator recipe
and every voice is the device's TTS engine, which differs by phone, cannot
laugh, and reads "Bock bock bock" as text. The reference's sounds are produced
samples with character: a real cork, a real cash register, a real bray. Dan:
"all of our current sound effects aren't great." They cannot be, in this
format.

**W4. There is no entitlement.** `fn_use_throwable(p_throwable_id)` (live
definition read today) checks VIP only to decide whether the throw is free; it
never looks at WHICH item. Anyone can throw anything in the "VIP" tab for one
diamond. Nothing is purchasable per item; the marketplace sells throw PACKS
(uses), not throwables. The picker has no locks, no badges, no prices. Dan's
"VIP only" and "purchasable only" items need a model that does not exist yet.

**W5. Our reactions are stickers; their emoticons are performances.** Our 8
reactions float in and sparkle. Their 14 emoticons REPLACE the target's face
for four seconds and act: the crying face grows tear streams and a puddle, the
heart-eyes face sprouts pulsing hearts and a nosebleed, the angry face reddens
and catches fire, the party face blows a horn and throws streamers. The
emoticon set is where the reference is furthest ahead and where the most
throws will happen (they are the social layer of the table).

**W6. Nobody is using them.** `throw_usage` holds 100 rows from 2 accounts,
all but four on 2026-08-21 and 08-28. That is test data. The feature has not
found a player yet, so nothing in the current design is validated by use;
the reference is the only signal.

**W7. Asset hygiene.** 300-620 KB JPGs per item, decoded and flood-filled
in every session on every device; six renders on white (angry_emoji, star,
cake, basketball, football, bowling_ball) that only work because the cutout
samples the corner colour; no manifest, no versioning, the catalogue id IS the
filename. A Lottie for a full character performance is 20-80 KB and needs no
cutout.

**W8. Small defects found while reading.** The catalogue header says 14
premium items and lists 13. `LEGACY_ID_MAP` maps `tsunami` and
`water-balloon` to `water_gun` and `dragon` to `bomb`, which tells a
receiving client a different item was thrown than the sender chose. The
throwable-selector's "VIP" tab is the default tab for non-VIP users, who then
pay a diamond for every item in it. `IMPACT_CAPTION` puts words on the felt
(STRIKE!, IT'S GOOD!, PEE-YEW, STINKY!, UH OH) that the reference only does
once ("GOOD LUCK"), and `titleCase.ts` renders them; that is fine but the
captions and the voice lines are the same text said twice.

### 2.3 What is right and must survive the rebuild

- Every duration through ONE `--animation-speed` (JS timeline variables
  handed to CSS; audio cue offsets multiplied by the same speed). Pinned by
  `tests/animations-always-play.law.test.ts`.
- Flinch and shake scoped to THIS table via `closest('.table-page')`.
- A throw with no resolvable target is reported, never silently dropped.
- Speed read ONCE per throw so a setting change mid-flight cannot desync.
- `fn_use_throwable`: advisory lock per user, free allowance, pack credits,
  then diamonds, all in one transaction.
- `[THROW:<id>:<seat>]` on the engine chat channel, legacy ids bridged.
- The KnockoutFlurry is the boxing glove. It stays.
- `ThrowableImage`'s error ladder (cutout -> sized -> raw -> glyph).

---

## 3. Target architecture

### 3.1 The asset: a rigged, layered, timeline animation per item

**Format: Lottie (bodymovin JSON), one file per throwable, three named
compositions inside it: `projectile`, `payload`, `residue`** (residue may be
empty). Rendered with `lottie-web` (canvas renderer on the table for
performance; SVG renderer in the picker for crispness). Why Lottie and not
sprite sheets, video, or more CSS:

- it is VECTOR, so one file is crisp at the 56 / 66 / 84 / 104 px seat rungs
  and at 2x on a phone, where a sprite sheet needs four exports and a video
  needs a poster and a codec;
- it is a TIMELINE with named markers, so "the cork pops at frame 24" is a
  fact in the file that the spec can read and a test can pin, not a CSS
  percentage somebody has to keep in step;
- playback speed is a property (`setSpeed(1 / animationSpeed)`), so the
  Animation Speed law costs one line per throw;
- it is authored in After Effects / LottieFiles by an animator, which is the
  skill this actually needs. A CSS keyframe file is not where a beer clink
  gets designed;
- 20-80 KB gzipped per item against 300-620 KB per still today.

Where Lottie is the wrong tool (a dense particle fireworks burst, a
photographic splat), the composition embeds a small WebP/APNG sprite for
that layer. The rule: one file per item, and the file is the whole animation.

The art direction is Dan's call (section 6): a consistent 2D cartoon set like
the reference, or 2D animation built AROUND our existing 3D renders (the
renders become the "hero" layer, animated parts are drawn to match). The
second keeps the 49 renders Dan already approved and is faster; the first
reads more like the reference.

### 3.2 The spec: one script per item, and the code just plays it

```ts
interface ThrowableSpec {
  id: string; // == asset filename stem
  name: string;
  tier: 'free' | 'vip' | 'premium';
  priceDiamonds?: number; // premium only
  category: 'characters' | 'objects' | 'cheers' | 'emoticons' | 'special';
  asset: string; // throwables/<id>.json (Lottie)
  spawn: 'avatar-face' | 'avatar-corner' | 'none';
  spawnMs: number; // scale-in + hold before launch (100-300)
  flight: { ms: number; mode: 'straight' | 'none'; tumble?: boolean; upright?: boolean };
  arrival: 'blink-pop' | 'land' | 'none';
  payload: {
    sizeU: number;
    anchor: 'face' | 'above' | 'left' | 'right';
    coversAvatar: boolean;
    ms: number;
  };
  residue?: { ms: number; fade: 'cut' | 'fade' };
  beats: Array<{ at: number; marker: string }>; // ms from launch; markers exist in the Lottie
  audio: Array<{ at: number; sample: string; gain?: number; loopUntil?: number }>;
  caption?: { text: string; at: number }; // the one sanctioned on-felt word, e.g. GOOD LUCK
  haptic?: 'light' | 'medium' | 'strong';
}
```

`ThrowAnimation` becomes a player: spawn the projectile composition on the
thrower's seat, translate it in a straight line for `flight.ms`, run the
`arrival` micro-animation, mount the payload composition at the target with
`sizeU * --seat-avatar-base`, play it, schedule every audio cue on the
AudioContext clock at `at * speed`, and remove everything at the end of the
last composition. The seven physics profiles and nine impact profiles are
deleted with their CSS; `ThrowableSignatures.css` is deleted; what a throwable
does lives in its asset and its spec, in one place per item.

A spec is data, so `tests/throwables/specs.test.ts` can assert for EVERY item:
every audio `at` has a marker within 100 ms, flight is 133-400 ms unless
`none`, payload life is 1.8-5.0 s, total life 2.0-5.5 s, every sample named
exists in the manifest, every marker named exists in the Lottie, tier and
price are consistent. The reference's grammar becomes a test, not a memory.

### 3.3 Sound: a sample library, scheduled on the audio clock

- `public/sounds/throwables/<cue>.webm` (Opus, 48 kHz, mono, -16 LUFS
  loudness-normalised, peak -1 dBTP) + `.m4a` fallback for Safari; produced or
  licensed, never generated at runtime. Roughly 2-4 cues per item, ~150 cues.
- `ThrowableSoundService` becomes a loader + scheduler: decode once, cache
  `AudioBuffer`s, `source.start(ctx.currentTime + at/1000 * speed)`, pan to
  the impact x. Loops (dice rattle, chewing, crowd bed) use `loop` with
  `loopUntil`. Nothing is `setTimeout`-scheduled: the knockout learned that.
- `ThrowableVoice` (TTS) is retired. Where a voice belongs (the bear's laugh,
  the donkey, the chicken, the sobs) it is a RECORDED vocalisation in the
  library. If Dan wants spoken lines, they are recorded once, in one voice,
  and shipped as samples: the K.O. call note in `SoundService` already says
  how (300 ms, close-mic'd, no reverb).
- Preload policy: the picker's visible tiles' cues on open; everything else
  on first use; the whole library is ~3 MB, cached by the service worker.

### 3.4 Entitlement: catalogue, ownership, and a refusing RPC

```sql
create table throwable_catalog (
  id text primary key,                 -- == spec id == asset stem
  tier text not null check (tier in ('free','vip','premium')),
  price_diamonds integer,              -- premium only
  enabled boolean not null default true,
  sort integer not null,
  season text                          -- optional: 'halloween-2026'
);
create table user_throwables (         -- ownership of premium items
  user_id uuid references profiles(id),
  throwable_id text references throwable_catalog(id),
  acquired_at timestamptz default now(),
  source text,                         -- 'purchase' | 'gift' | 'promo'
  primary key (user_id, throwable_id)
);
```

`fn_use_throwable(p_throwable_id)` gains, before the allowance logic: the
item must exist and be enabled; `vip` requires an active VIP; `premium`
requires a `user_throwables` row. A refusal returns a reason the client can
turn into the right prompt (`vip_required` -> the VIP page; `not_owned` ->
the purchase sheet). `fn_purchase_throwable(p_throwable_id)` charges diamonds
through `deduct_diamonds` and writes ownership in one transaction, keyed
idempotently. Receiving clients render ANY id they know; entitlement gates
sending only, so a non-VIP still sees a VIP item thrown at them.

The picker follows the reference: sections as scroll anchors (Recently Used,
Characters, Objects, Cheers, Emoticons, VIP, Premium), a gold V badge on VIP
tiles, a padlock + diamond price on premium tiles you do not own, one tap on a
locked tile opens the purchase sheet, one tap on an owned tile throws. Two
taps from seat to throw, no Confirm.

### 3.5 Delivery, size, and the darkroom

- `public/throwables/<id>.json` shipped with the bundle through the additive
  asset pool (the publisher never deletes, so a mid-hand client still finds
  the previous release's file). Manifest `src/throwables/manifest.ts`
  generated at build from the specs, with a content hash per asset.
- `lottie-web` (canvas build) is ~60 KB gzipped; loaded lazily with the
  table chunk. Measured budget: 8 simultaneous payloads at 60 fps on a
  375 px phone, verified in the harness before phase 3 ships.
- `scripts/dev/preview-throwable.mjs`: the KnockoutFlurry darkroom
  generalised. For any spec it renders our animation beside the reference
  frames at the same timestamps, at the four seat rungs, and writes a
  self-contained `harness.html`; optionally drives Playwright for the 60 fps
  measurement. No throwable ships without its contact sheet.

### 3.6 Laws and pins

- `tests/throwables-always-play.law.test.ts`: every spec has an asset, every
  asset has its markers, every cue has a sample, speed pairing, table
  scoping, no TTS, no `will-change`, no arc/lob/spiral keyframes reappearing.
- `tests/unit/throwableSpecs.test.ts`: the grammar bounds from 3.2 for every
  item, and the reference-parity beats for the 26 items with a PokerBros
  twin (e.g. beer: mug 2 pops at 900-967, clink at 1567; champagne: cork at
  800; bomb: fuse 1.2 s, boom at 1467).
- `tests/unit/throwableEntitlement.test.ts`: the RPC refuses a VIP item to a
  non-VIP, a premium item to a non-owner, and never refuses a receive.

---

## 4. The build sheets: every item, what it does, what it sounds like

Conventions: times are ms from LAUNCH at speed 1.0 (spawn on the thrower is
negative); `u` = target avatar width; "char" = the character rhythm from 1.1
(spawn on the face, straight flight of the full sprite, blink, pop with
overshoot, perform, cut); "obj" = the object rhythm. Tiers are the proposal;
section 6 asks Dan to confirm them. Sound cue names are the library file
names. Every sheet ends with a life and a cut.

### 4A. Reference parity: the 23 we already have (rebuild to the measured beats)

**water_gun** (free, obj, 3.6 s). Rebuild to 1.3: spawn -100..0; flight 267;
dot + pop 1.1x at 400-533; hold; pull back down-left 767-900 so the barrel
aims UP at the face; SQUIRT 933: cyan stream from barrel to face + a cyan
splat FACE 2.0 u (two white eyes with pupils) covering the avatar; loop to
3433 with droplet pulses every 270 ms and +-4 px recoil; splat off in one
frame; gun shrinks out by 3567. Sound: `squirt_start` at 933, `squirt_loop`
933-3433 (pump + water hiss), `drip` at 3467. Delete our splash/particles.

**beer** (free, obj, 4.5 s). Upright flight 333; land 1.1x; mug 1 slides
right 533-1200; mug 2 pops in left 900 (`pop_soft`); swing in 1400-1567;
CLINK 1567 over the forehead with a foam plume 0.8 u and 8-12 droplets
(`glass_clink_rattle`, 1.3 s ring); V hold to 2367; ease apart; rest flanking
the face; cut 4500. Keep the caption CHEERS! only if Dan wants words (the
reference has none).

**fireworks** (free, cheers, 3.0 s + 0.9 s pre-delay). Spawn NOTHING at the
thrower; after 930 ms three rockets rise from the avatar's edges one after
another and burst blue (0.85 u) / magenta (1.2 u) / yellow-to-ember
(1.0 u) at 233, 567, 1033; gap; three rise together and burst together at
2333 (group 2.4 u, white-hot centre); darken and fade by 3000. Sound:
`fw_whistle` 0-830, `fw_crackle` cluster 590-1200 (one bang per 150 ms),
`fw_rumble`, `fw_barrage` at 2400 (loudest), tail to 4100. Particle layer
as an embedded sprite in the Lottie; the current 22-particle CSS scatter
goes.

**doge** (VIP, char, 4.4 s). Pixel SUNGLASSES fade in on the thrower's eyes
-167..0, fly 200 ms at 17 px/frame onto the target's eyes; glasses off,
DOGE HEAD pops from the centre with the full damped bounce (0.23 -> 1.4 ->
0.85 -> 1.0 in 300 ms) to 1.05 u; hold; glasses re-enter from upper-right and
slide onto the Doge's eyes 1433-1600; 16-ray yellow SUNBURST fades in behind
1633-1767 (2.2 u) and shimmers; cut 4333. Sound: `bass_boom` on landing
(1 s decay, peak on the overshoot frame), `doge_sting` (2-bar beat, 112 BPM)
from 1633 to 4900. Our current render already wears the glasses; the asset
gets a bare head plus a separate glasses layer.

**horseshoe** (free, obj, 4.5 s). Flight 200 no spin; one soft bob (12 px up
and back, 400-1000); glow bloom 1167-1433; "GOOD LUCK" label grows out of the
glow 1467-1667 with a 45-70 px ray burst; holds to 3767+; four green clovers
grow from the corners 1867-2100; cut ~4500. Sound: `tick_land` 350,
`horseshoe_clank` 800 (bottom of the bob); the label pops silent, then a
RECORDED male **"Good luck"** (`voice_good_luck`, 420 ms, F0 rising 137 ->
210 Hz) about 300 ms after the label settles (~2100). This is the one
sanctioned on-felt word in the set and one of the two recorded lines.
Replace the TTS "Good luck" with the recording.

**trash_can** (VIP, obj, 4.5 s: the 2-7 gag). Flight 267-467 upright; land
one frame; can VANISHES 533-800; card 2 pops out upper-left and lands
lower-left 833-967; card 7 pops out upper-right and lands lower-right
1000-1100; grawlix bubble 1267-2467; cards shift right 1833-2000; can rises
from below at 1.2 u 1967-2100; lid opens and hovers 2200-2500; the 2 then
the 7 rise, rotate and fall in 2533-2967; lid closes 3000-3133; flies buzz at
the lid 3500-4467; cut 4500. Sound: `card_slap` x2 at 900 and 1050,
`bubble_tick` 1267, `can_rattle_rise` 1967-2100, silence, `lid_clank` 3000,
`flies_buzz` 3500-4467. Replace the TTS "Stinky!" and the STINKY! caption.

**boxing_glove** (free, 2.1-2.4 s). Already the KnockoutFlurry minus the
stamp. No change. The reference's four-punch version is recorded in 1.3 for
completeness; ours is Dan's own art and stays.

**dice** (free, obj, 5.6 s). A PAIR of dice spawn 0-100 and TUMBLE in flight
100-333 (the only rotating projectile); land, swap for a HAND 1.3 u tall
cupping the dice over the left half of the face; loop: upright hold 367-960,
dip, palm-down jiggle 1300-1600, low hold, shake, repeat (cycle ~1.4 s);
cut 5600. Sound: `dice_rattle` bursts of 4-6 clicks ONLY while the hand
visibly shakes (1300-1900, 2800-3000, 5000-5700). Replace "Let's gamble" TTS
and the LET'S GAMBLE caption.

**champagne** (free, cheers, 4.7 s). Bottle spawns -233..0, flies UPRIGHT
267; stands centred 433-767; CORK POP 800 (white puff), foam JET 933-1533
25-40 px above the neck with side droplets; jet detaches into a rising thread
1567-1900; rest; bottle cross-fades into ONE flute 2300-2467; second flute
fades in left 2700; V-tilt and CLINK 3167 with yellow droplets; flank the
face 3267-3500; fade 3533-4700. Sound: `cork_pop` 800 (the loudest cue in the
library, -6 dB below the KO finisher), `fizz_loop` 1000-3200,
`flute_clink` 3167, two `flute_clink_soft` 3900 / 4100.

**snowman** (free, obj, 2.2 s: the clown-splat). Flight 233-600 straight at
24 px/frame; land; SPLAT 633: figure vanishes leaving the red nose; white
powder plume grows ABOVE the head 667-767 (0.7 x 1.2 u); specks spray; the
red nose FALLS to the chin at 1 px/frame; cartoon cloud lingers 1000-1933
with shifting lobes; fades 1967-2200. Sound: `poof_soft` 800. Our render is a
snowman head with a hat; the animator keeps our design and the reference's
beats.

**bear** (VIP, char, 4.5 s). Spawn on the face -167..0; LIFT above the
thrower's head then fly 200-400 with a +-10 deg wobble; shrink to a dot
433-533; pop to 1.5 u 567-667 (no overshoot); LAUGH loop 700-2000 (mouth
works, head bobs); ANGER 2033-4467: red throbbing-vein mark top-right, face
flushes red over 400 ms, shout, yellow star highlights in the eyes, tremble
+-3 px; cut 4500. Sound: `bear_laugh` (rhythmic ha-ha every 100-130 ms)
800-1500, `bear_breath`, `bear_laugh_2` 1800-2000, `bear_grumble` 2033-2500,
`bear_roar` 2500-4500, tail 500. Replace the TTS "Roooaaar".

**trophy** (free, cheers, 4.5 s). Upright flight 267-367 (fastest in the
set); statuette vanishes, a grey wisp rises above the shoulder 400-600; a
golden-white SPOTLIGHT BEAM grows above the avatar's left 633-1267 with the
statuette forming at its base; beam fades 1300-1600; statuette stands on the
shoulder with white sparkle glints to 4500. Sound: `swell_low` 400-800,
`chime_shimmer` 1267, `fanfare_short` 1600, `sparkle_bed` 2000-4500. Replace
"You're the best" TTS and the caption.

**cracked_egg** (free, obj, ~3.5 s). Spawn -300..0 (130 ms in, 170 ms hold);
flight 367 straight at 20 px/frame; CRACK 400: one frame, egg becomes a yolk
cap on top of the head (0.65 u) with white drips to the chin; residue static
to ~3500; cut. Sound: `egg_crack` 400, `drip_tick` 700. Delete our egg
particles.

**cake** (VIP, obj, ~3.5 s). Spawn/hold 233; flight; cake sits INTACT and
presses up 3 px/frame for 100 ms; SQUASH: cake tips, cream spreads; the PLATE
turns face-on as a white disc 0.55 u centred on the face with pink/white
splatter; plate SLIDES DOWN the face 1 px/frame for 470 ms; plate fades;
residue = cream smear + strawberry at the crown, static to ~3500. Sound:
`whoosh_low` on approach, `splat_heavy` exactly on the squash frame,
`splat_wet_small` as the plate starts sliding.

**rocket -> missile / airstrike** (premium, obj, 4.0 s). Rebuilt as the
reference's three-stage strike: a red CROSSHAIR fades in on the thrower's
head -300..0, flies 300; LOCK-ON 333-1600 with a hunting jitter (+-5 px, one
sweep per 830 ms); LOCK 1633-1700 (scale 2x -> 3.5x, fade); 430 ms of nothing;
the MISSILE dives from the top screen edge 2267-2533 growing 4 -> 14 px with
exhaust; HIT 2567 (red glow); flame 2633-2700; FULL FIREBALL 2733-2833 (1.3 u,
50 px above the head, avatar hidden); orange + embers 2867-3000; khaki
MUSHROOM CLOUD 3033-3667; pop out; clean 3733. Sound: `lock_beep` x4 every
533 ms from 567, `lock_confirm` double at 1633/1800, `missile_whistle`
2100-2930 (descending), `explosion_boom` 2833-3733. Our rocket render becomes
the missile.

**banana_peel** (free, obj, ~3.5 s). Short flight; IMPACT FLASH 133-200
(yellow star-burst, white core, 5-6 rays, 0.5-0.7 u); residue: the PEEL
draped over the top of the head like a hat, 40% of the face, static; cut
~3500. Sound: `boing_splat` starting 70 ms BEFORE the flash. Delete our
lob/bounce.

**cash_stack** (VIP, cheers, 3.6 s). Flight 300 straight; bundle OVERSHOOTS
above the head 367 and FALLS BACK with ease-out to the face 400-667; BURST
700-867 (single bills peel off); MONEY CLOUD 900-3000: 10-15 winged bills
fountain in a 1.75 u cloud from the chin to 60 px above; thins 3033-3233;
last bills exit upward; clean 3533. Sound: `thump_soft` 333, three
`tick_settle`, `cash_register_cascade` 700-4000 (peak on the burst).

**poop** (VIP, obj, ~3.5 s). Flight 300 straight; contact 367; SPLAT 400:
brown-orange splat 0.85 u with radial spikes and one droplet fired straight
up 30 px; 3-4 droplets fly out and hang 433-867; residue = the swirl on the
face inside a splash ring, ~70% covered; cut ~3500. Sound: `splat_wet` 433.
Replace "Pee yew!" TTS and the PEE-YEW caption.

**tomato** (free, obj, ~3.5 s). Flight 233; SQUASH frame 267 (tomato drawn
flat, semi-transparent); BURST 300: red splat 0.75-0.85 u with 6-8 chunks
thrown 6-10 px; settles 467-733 with the stem centre-top and drips to the
chin; residue ~70% of the face; cut ~3500. Sound: `splat_wet` 333.

**shark** (premium, char, 4.3 s). Spawn at the face centre; 0.6 u sprite
flies 267 with a knife in one fin and a fork in the other; invisible 300;
pop 333-400; OVERSHOOT 1.5x one frame 433; settle 0.9 u; CHEWING loop
500-3833 (jaw every 170-200 ms, cutlery bobs, a morsel at the mouth); cut 4300. Sound: `chomp` 500, `chomp_soft` 700, `chew_tick` one per jaw cycle
733-3800. Replace the TTS "Heh heh heh".

**chicken** (free, char, 4.3 s). Char rhythm; pop 333-467; idle; PECK
867-1200 (head down 20 deg); head-up bobs 1267-2267; CLUCK with the beak wide
2333-3000; half-open bobs to 4300. Sound: `thud_land` 500, `cluck_soft` x3
at 700/930/1160, `bawk` 1467, `cluck_bed` 1900-3700. Replace "Bock bock bock
bock booook" TTS.

**bomb** (free, obj, 2.0 s). Spawn/hold 0.35 u with a sparking fuse; flight
233; LANDS ON THE FOREHEAD and stays 267; FUSE 1.2 s (spark flickers 3-7 px,
fuse shortens); pre-flash 1433; EXPLOSION 1467 (jagged yellow-orange burst
1.1 u); khaki SMOKE puff 1600-1800 drifting up-left; clean 1833. Sound:
`fuse_ignite` 433, `fuse_sizzle` 700-1433 (crescendo at the end), `boom` 1500.
Delete our 4.5 s scorch linger.

**rose** (free, cheers, 3.4 s+). Upright flight 300; rose invisible 367-467;
a BUD appears behind the right ear 500 and GROWS into a full rose tilted
30 deg 567-667; a pink BUTTERFLY flutters above in an 8 px loop 867-3033
(wings every 2 frames); a red LIPSTICK KISS on the cheek 1467, grows, then
DRIFTS DOWN to the chin 2633-3033; cut ~3500. Sound: `harp_sparkle` 767-2400.

### 4B. Reference parity: the 15 we do not have (new items)

**rat_card** (premium, char, 4.3 s: "the cheating rat"). `mouse_card` already
exists as a legacy id, so the wire is ready. Char rhythm at 0.75 u; pop to
1.05 u covering the face; idle with tongue out; head tilt + WINK 833-900;
face-down CARD slides out of the mouth 967-1300; chews with the card held
1367-2167; card FLIPS edge-on 2300; ACE OF SPADES shown 2433-4167 while it
laughs, tongue wags, head bobs; cut 4300. Sound: `pop_high` 333, `rat_squeak_1`
1100 (descending, 300 ms), `rat_squeak_2` 1400, `card_slide_ticks` 1467,
`gulp` x2 1600/1900, `rat_laugh_hiss` 2200-2600, `rat_squeak_final` 3000,
`pop_faint` 4300.

**donkey** (premium, char, 4.4 s). Char rhythm; pop with 1.3x overshoot;
idle mouth/ear wiggle 633-1500; mouth opens wide (inhale) 1533-1967; BRAY
2000-3100 with teeth, head bobs, wide eyes; relax 3133-4333; cut 4367.
Sound: `donkey_hee` 1533-2000 rising, `donkey_haw` 2000, `donkey_bray_sustain`
2033-3300. Poker's own word for a bad player; expect this to be the most
thrown item on the platform.

**fish** (free, obj, 3.3 s: "slap with a fish"; poker's word for a bad
player, the reference's last row). Flight 300 head-first; IMPACT FLASH 300
(the banana star-burst); fish lies DIAGONALLY across the upper face; rests
with a 1 px wiggle 367-1667; SLASH 1 1700-1800 (a light blade sweeps down,
spark exits top-right); SLASH 2 1967-2067; RED GASH on the fish and a red
streak on the face 2167-2533; fish SLIDES DOWN the face rotating, fades
2567-3100; mark fades by 3400. Sound: flash SILENT, `fish_flop_tick` every
133 ms 700-1667, `blade_whoosh_1` 1700, `blade_whoosh_2` 1967.

**Emoticons (14).** All char rhythm at 0.6-0.8 u in flight, 0.9 u on the
face, blink + pop with 1.3-1.4x overshoot (the heart-eyes and angry faces pop
HIGH, 24 px above the face, then drop), 3.9-4.0 s on target, hard cut. Five of
our reactions are UPGRADED INTO these rather than duplicated (the id stays,
the performance changes):

| id (ours -> new)                                                                                          | Performance on the target's face                                                                                                                                                                                   | Sound                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `party_face` (new)                                                                                        | neutral 0-467; party HORN pops out of the mouth 500; mouth opens progressively 633-1167 with purple confetti; eyes squeeze shut 1300-1567; red/green/purple STREAMERS fan from the horn and the hat 1567-4000      | `horn_toot_rise` 500, `whistle_burst` 900, `crowd_cheer_bed` 1300-3800                                                                                                                                           |
| `laughing_emoji` -> laugh with tears                                                                      | smug squint with rosy cheeks 467-800; LAUGH: mouth wide with tongue, eyes squeezed, head rocks 867-4000; tear drops fly from the eyes every 400 ms                                                                 | `laugh_long` (recorded cartoon laugh in three swells), 4.0 s from 500                                                                                                                                            |
| `loser_hand` (new; the reference's "laughing face with raised hand": the hand makes an L on the forehead) | smug squint 467-800; the hand rises and plants the L on the forehead 800; head rocks on each word; mouth shapes the words                                                                                          | RECORDED voice: `voice_oooh` (one sustained note, F0 ~230 Hz, 1.2 s) at 600, then `voice_loser_x3` ("Loser, loser, loser", 0.8 s each, F0 120-150 Hz) 1800-4300. The second of the two recorded lines in the set |
| `crying_emoji` -> loudly crying                                                                           | SAD (eyes closed, brows drooping, "o" mouth) 467-1133; CRY 1200: mouth wide, two CYAN TEAR STREAMS straight down past the chin, a cyan PUDDLE spreads to 30 px; ripple loop to 4000                                | `sniffle` 1000, `sob_1` 1367, `cry_wail` 1600-2300 (a recorded high cartoon cry, F0 ~350 Hz), `sob_bed`, `cry_burst` x2 at 3300/3500 (the loudest cues in the emoticon set)                                      |
| `heart` -> heart eyes                                                                                     | pop HIGH then drop; SURPRISED (round eyes, ":3") 633-900; eyes become PINK HEARTS 967 and GROW + pulse 1033-1433; a dark-red NOSEBLEED drip runs over the mouth 1500; pulsing to 4000                              | `twinkle_shimmer` 500-1700, `heart_thump_soft` 1600-2400                                                                                                                                                         |
| `angry_emoji` -> angry on fire                                                                            | ANGRY 600-1600: colour ramps orange -> deep red with a heat shimmer; shout 1667-1867; FLAMES erupt from the head 1933 with an anger-star top-right; RAGE loop 1933-4200 (flame flickers, mouth works, head shakes) | `growl_bed` 700-1900, `roar_whoosh` x4 every 700 ms from 2067, `grunt_low` 3000                                                                                                                                  |
| `thinking` (new)                                                                                          | full damped bounce on landing; a hand rises from the bottom-left 600-900; brows knit into a frown 900-1200; hand on chin with moving eyebrows ("hmm" loop) to 4000                                                 | `boing_pop` 433, `hmm_murmur` 1200                                                                                                                                                                               |
| `cool_sunglasses_emoji` -> deal with it                                                                   | the glasses DROP from above the face and land on the eyes with a bounce 500-800; smug grin; a slow head tilt; sunburst rays behind (the doge's) 1600-4000                                                          | `glasses_snap` 700, `smug_sting` (short 1-bar) 1600                                                                                                                                                              |
| `blush` (new)                                                                                             | closed-eye smile; cheeks bloom pink 600-1000; a small heart floats up 1500; gentle sway                                                                                                                            | `giggle_soft` 600, `pop_soft` 1500                                                                                                                                                                               |
| `ok_smug` (new)                                                                                           | OK-hand sign rises beside the face 600; one eyebrow up; wink 1500; hand pulses on each beat to 4000                                                                                                                | `ding` 600, `click_tongue` 1500                                                                                                                                                                                  |
| `sleeping` (new)                                                                                          | eyes close, nightcap slides on 600; head nods forward 1200 and jerks back 1500; "Zzz" letters float up-right every 800 ms; a snot bubble inflates and pops 2800                                                    | `snore_loop` 1000-4000, `bubble_pop` 2800                                                                                                                                                                        |
| `facepalm` (new)                                                                                          | eyes wide 467; the hand comes up and covers the face 900 with a slap; one eye peeks between fingers 2000; slow head shake to 4000                                                                                  | `slap_face` 900, `sigh` 1400                                                                                                                                                                                     |
| `screaming` (new)                                                                                         | eyes go white and huge 600; mouth opens to a scream 900 with hands on the cheeks; the head SHAKES +-3 px; blue sweat drops fly 1200-3000; jaw drops off 3400                                                       | `scream_short` 900, `scream_long` 1600-3200                                                                                                                                                                      |
| `vomit_rainbow` (new)                                                                                     | green tint spreads 600-1200; cheeks puff 1300; a RAINBOW arc pours from the mouth to the bottom of the seat 1600-3600 with sparkles; wipes mouth 3800                                                              | `gag` 1300, `splash_rainbow` 1600-3600 (a wet whoosh with a shimmer)                                                                                                                                             |
| `surrender` (new)                                                                                         | a white FLAG rises from behind the head and waves 600-4000; eyes droop; a blue sweat drop                                                                                                                          | `flag_flap_loop` 600-4000, `sad_trombone_short` 1200                                                                                                                                                             |

The remaining three reactions become emoticons in the same rhythm:
`thumbs_up` (thumb rises, gold glint, two nods), `thumbs_down` (thumb drops,
grey wash, one slow shake, a raspberry), `star` (a star lands on the forehead
and pulses gold, small sparkles orbit, a `twinkle` cue).

**Special (2, locked in the reference).** These are our own designs behind
the same padlock: `energy_ball` (premium): a crackling blue plasma sphere
spawns on the thrower, flies with a lightning tail, ENGULFS the target's seat
in a 2.0 u sphere for 2.5 s with arcs crawling over it, then collapses to a
point with a flash. `sloth` (premium): a sloth head pops on, blinks once every
1.5 s, yawns at 2500, and the seat's action badge is drawn "slowed" with a
z-z-z; 4.5 s. Sound: `plasma_hum_loop` + `zap_collapse`; `sloth_yawn`.

### 4C. Ours with no twin: 25 redesigned to the grammar

Seventeen objects and characters below, plus the eight reactions that become
emoticons (five are specified in the 4B table; thumbs_up, thumbs_down and
star at the end of this list). Each keeps its render (or is redrawn to match
the set) and gets a choreographed payload. Flight is straight, 200-333 ms;
life 3.5-4.5 s unless a gag is shorter.

- **pizza_slice** (free, obj): lands FACE DOWN on the avatar, slides down
  leaving a cheese smear; the slice peels off at 2200 and drops out of frame;
  a pepperoni stays stuck on the forehead. `splat_cheese`, `peel_off`.
- **anvil** (VIP, obj): the only allowed drop-from-above. A cartoon shadow
  grows on the seat 0-600 (this is the one item that keeps a target
  telegraph), the anvil slams from off-screen top at 600 with a 2 px seat
  displacement, dust ring, "OOF" caption; the avatar is drawn FLAT (squashed
  to 0.3 height) under it 700-2500; the anvil lifts and the face pops back
  round. `whistle_fall`, `anvil_clang`, `pop_round`.
- **magnet** (free, obj): lands above the head; the target's CHIPS (drawn as
  a chip-stack sprite, not the real stack) fly up and stick to it 800-1600;
  the magnet flies back toward the thrower with the chips at 2400 (a
  sanctioned second flight). `magnet_hum`, `chip_clatter`, `whoosh_back`.
- **basketball** (free, obj): a hoop pops up above the head 300; the ball
  arcs in (the ONE arc in the set), swishes 700, net ripples, the ball bounces
  off the head twice and rolls out. `swish`, `bounce` x2.
- **football** (free, obj): goalposts pop up 300; the ball spirals through
  900; the posts flash; "IT'S GOOD!" caption. `spiral_whoosh`, `crowd_short`.
- **tennis_ball** (free, obj): fast flight 200; hits the forehead and
  bounces straight back toward the thrower 400, hits again 700, again 1000
  (three diminishing bounces); the face gets a red circle mark 1100-3500.
  `tennis_pop` x3 diminishing.
- **bowling_ball** (VIP, obj): rolls IN along the felt from the thrower's
  side (the one rolling flight); the target's chips (sprite) stand up as ten
  pins 300; STRIKE 900, pins scatter; "STRIKE!" caption. `roll_rumble`,
  `pins_crash`.
- **magic_8_ball** (free, obj): lands; shakes 400-900; the window flips blue
  and an answer floats up 1100 ("ASK AGAIN LATER" / "OUTLOOK NOT SO GOOD" /
  "IT IS CERTAIN", chosen by hash of the throw id so every client shows the
  same one); holds to 4000. `liquid_slosh`, `mystic_chime`.
- **coffee** (free, cheers): the cup lands upright; steam curls 400-2000; the
  avatar's eyes go WIDE (an overlay pair of eyes) 1200; the cup tips and a
  brown splash covers the mouth 2400; residue smear. `sip`, `steam_hiss`,
  `hot_splash`.
- **diamond** (VIP, cheers): lands and SPINS in place 400-1600 with lens
  flares; shatters into 12 shards that rain down over the seat 1600-3000
  (`crystal_chime`, `shatter_glass`). Consider merging with "Diamond Shower"
  in 4D.
- **ufo** (premium, char): swoops in on an S-curve (the one swoop), hovers
  above the head 400-1400 with a tractor BEAM; the avatar is drawn lifting
  and shrinking up the beam 1400-2400; the ufo zips off; the face pops back 2600. `ufo_warble`, `beam_hum`, `zip`.
- **alien** (premium, char): pops on with big black eyes; antennae glow;
  a speech bubble with alien glyphs 1200; the eyes flash green 2400; "probe"
  joke: a green ring scans the face top to bottom 2600-3400. `alien_blip`,
  `scan_sweep`.
- **robot** (premium, char): pops on; visor eye scans in `steps(6)` (keep
  the 08-29 design); antenna blinks; SHORT-CIRCUIT 2200: arcs in `steps(3)`,
  smoke from the ears 2600; head flops 3400. `servo_whir`, `zap_short`.
- **ghost** (free, char): fades in translucent, wavers, passes THROUGH the
  face twice as a cold double ripple 800/1600 (keep the 08-29 design), then
  the target's avatar is drawn pale for 1.5 s. `ghost_woo`, `chill_ripple`.
- **skull** (premium, char): pops on; the jaw chatters 600-1400; the eyes
  flash red 1600; the skull cracks down the middle 2400 and the two halves
  fall away; "RIP" gravestone briefly behind 2600-3800. `bone_rattle`,
  `crack_stone`.
- **lightning_bolt** (VIP, obj): the only item with no projectile: a storm
  cloud forms above the head 0-600 with a warning glow; the BOLT strikes at
  700 (one-frame white flash, the whole seat inverted for one frame); the
  avatar is drawn as a smoking silhouette with white eyes 800-2400; hair
  stands up. `thunder_rumble`, `strike_crack`, `sizzle`.
- **rubber_duck** (free, obj): lands, squeaks and bounces three times
  600/1000/1300, floats on a small puddle that appears under it, rotates to
  face the camera 2000, one more squeak 3000. `squeak` x4, `water_lap`.
- **heart** (kept as the heart-eyes emoticon above; the standalone heart is
  retired; the legacy id maps to `heart`).
- **star** (emoticon above).
- **thumbs_up / thumbs_down** (emoticons above).

### 4D. New items: 8 VIP-only and 8 purchasable premium

**VIP-only** (require an active VIP; count against the free allowance):

1. **crown** "Crown Me": a gold crown descends from above the head 300-800 on
   a light beam, lands with a gem flash, three sparkles orbit, a "KING" or
   "QUEEN" ribbon unfurls under the chin 1600; 4.5 s. `fanfare_royal`,
   `gem_flash`.
2. **chip_rain**: a shower of the club's gold chips falls over the seat for
   2.5 s and stacks up at the bottom into a small tower; 4.0 s.
   `chip_cascade` (the real thing, not the cash register).
3. **diamond_shower**: 20 diamonds rain, each pinging, and pile up; the
   avatar wears a tiara at the end; 4.0 s. `crystal_rain`, `ping` x20.
4. **velvet_rope**: two brass stanchions pop up either side of the seat and a
   red velvet rope drops across the face 600; a "VIP ONLY" sign swings on it;
   the rope lifts 3400. `chain_clank`, `sign_swing`.
5. **champagne_tower**: a three-tier flute pyramid rises above the head
   0-900; a bottle pours from the top 1000 and the tiers overflow one by one
   1300/1900/2500; the tower sparkles; 4.5 s. `pour_loop`, `overflow_fizz` x3.
6. **standing_ovation**: eight clapping hands appear around the seat 300 and
   clap in time; roses land on the shoulders 1500/2100; a spotlight beam;
   4.5 s. `applause_bed`, `bravo_shout` (recorded).
7. **whale**: the felt under the seat turns into water 0-600; a blue whale
   surfaces 800, sprays a fountain over the face 1200-2400, dives 2800;
   4.0 s. `water_swell`, `whale_call`, `spray_hiss`.
8. **to_the_moon**: a moon rises behind the head 0-800; a rocket lands on it
   1200 and plants a flag; the flag reads the club's name; 4.0 s.
   `rocket_thrust`, `flag_plant`, `beep_moon`.

**Purchasable premium** (one-time diamond purchase, owned forever; still
consume a throw from the allowance):

1. **missile** (the airstrike from 4A; the reference marks it VIP, ours is
   the flagship premium).
2. **rat_card** (4B).
3. **shark** (4A).
4. **donkey** (4B).
5. **tilt_meter**: a thermometer pops up beside the face 300; the mercury
   climbs 600-1800, the bulb turns red, the face reddens with it; it BURSTS at
   1900 with a steam whistle and a "TILT" stamp (the KO stamp mechanism in
   red); 4.0 s. `pressure_rise`, `steam_whistle`, `stamp_slam`.
6. **bad_beat_bandage**: a bandage wraps around the head in three turns
   600-1500; an ice pack lands on top 1800; a tiny ambulance drives across the
   bottom of the seat 2200-3200 with a siren; 4.0 s. `wrap` x3,
   `ice_pack_thud`, `ambulance_siren_small`.
7. **bubble_boy**: a soap bubble forms around the whole seat 0-800; the
   avatar is drawn floating inside it, drifting up 1000-3200; it POPS at 3300
   and the face drops back; 4.0 s (the tournament bubble, made literal).
   `bubble_wobble_loop`, `pop_bubble`.
8. **slot_machine**: three reels drop over the eyes and mouth 300; they spin
   900-2200 and land 7-7-7 one by one; coins pour out of the mouth 2400-3800;
   4.5 s. `reel_spin_loop`, `reel_stop` x3, `jackpot_bell`, `coin_pour`.

**Seasonal (premium, time-boxed in `throwable_catalog.season`)**: pumpkin
(Halloween, the jack-o-lantern lands on the head and its face lights up),
snowball (December, a real snowball splat plus a scarf), party_popper
(New Year, confetti cannon), heart_arrow (February, Cupid's arrow).

### 4E. The sound library, counted

About 150 cues. Sourcing options are in section 6; the technical spec is
3.3. The cues that must be produced with real character rather than licensed
generically, because they ARE the item: `bear_laugh` / `bear_roar`,
`donkey_hee` / `donkey_haw` / `donkey_bray_sustain`, `rat_squeak_*`,
`laugh_long`, `sob_*` / `wail`, `scream_*`, `bawk` / `cluck_*`,
`horn_toot_rise`, `crowd_cheer_bed`, `applause_bed`, `bravo_shout`,
`whale_call`, `cork_pop`, `cash_register_cascade`, `chip_cascade`,
`glass_clink_rattle`, `doge_sting`, `smug_sting`, `fanfare_royal`, and the
two recorded lines `voice_good_luck` and `voice_oooh` + `voice_loser_x3`
(section 1.4: male, close-mic'd, no reverb; the pitch contours are measured
there so a recording can be matched to the reference or deliberately
bettered).

---

## 5. The plan, in phases

Each phase ends with something a player can throw. Nothing in a later phase
is needed to ship an earlier one. Estimates assume one engineer full time and
one 2D animator (After Effects / Lottie) full time; a second animator halves
phases 1-4. Sound work is a third stream and does not block the visuals
(a placeholder cue is legal until phase 5; a missing cue is not).

### Phase 0: foundation (engineer 1 week; animator onboarding in parallel)

- Art direction decided (section 6, decision 1) and the animator briefed
  with this document and the two reference files. Asset conventions written
  down: 512 px composition, 30 fps, named markers per beat, three named
  comps (`projectile`, `payload`, `residue`), colour palette, the seat plate
  as a guide layer.
- `src/throwables/spec.ts` (the schema from 3.2), `src/throwables/specs/`
  (one file per item), a generated manifest, and `ThrowablePlayer`
  (replaces the phase machine in `ThrowAnimation`): Lottie loading with the
  canvas renderer, marker-driven beats, straight flight, blink-and-pop
  arrival, seat-scaled sizing, speed law, table scoping. The old physics and
  impact profiles remain behind a flag until phase 3 removes them.
- `ThrowableSoundService` v2: sample loader, AudioContext scheduling, pan,
  loops. TTS retired (`ThrowableVoice` deleted).
- `throwable_catalog` + `user_throwables` migration (via
  `node scripts/new-migration.mjs`), `fn_use_throwable` tier checks,
  `fn_purchase_throwable`, and the picker's badges, locks and purchase sheet.
  Catalogue seeded with all 48 current ids at their proposed tiers so nothing
  a player owns today disappears.
- `scripts/dev/preview-throwable.mjs` darkroom: spec -> harness beside the
  reference frames at the four seat rungs.
- Laws from 3.6 written first, `it.skip` where the asset does not exist yet,
  un-skipped as each ships (CLAUDE.md 5.8).

Acceptance: `beer` rebuilt end to end with a placeholder Lottie and the
measured beats, throwable on the dev table, contact sheet beside the
reference, at 56/66/84/104 px, 60 fps with eight in flight.

### Phase 1: reference parity, the objects (animator 2 weeks; engineer 1 week)

The 16 object-rhythm items with a PokerBros twin: water_gun, beer,
fireworks, horseshoe, trash_can, dice, champagne, snowman, trophy,
cracked_egg, cake, banana_peel, cash_stack, poop, tomato, bomb, rose,
missile. Each shipped with its spec, its Lottie, its cues (placeholder
allowed), its darkroom sheet and its parity test. Ship in batches of four
behind the catalogue's `enabled` flag; flip on when the sheet matches.

### Phase 2: reference parity, the characters and emoticons (animator 3 weeks; engineer 1 week)

doge, bear, shark, chicken, rat_card, donkey, fish, and the 14 emoticons
(five of them upgrades of existing ids, so no wire change). The emoticon set
shares one rig (face, eyes, mouth, brows, hands) so the animator builds the
rig once and the 14 performances are variations; budget the rig at a week
and the performances at two.

### Phase 3: our own 22 redesigned, old code deleted (animator 2 weeks; engineer 1 week)

Section 4C. When the last of the 48 original ids plays through the new
player: delete the seven physics profiles, the nine impact profiles,
`ThrowableSignatures.css`, the CSS half of `ThrowAnimation.css`, the
procedural recipes, the flood-fill cutout and the still renders' runtime
path. Move every pin in `tests/animations-always-play.law.test.ts` that
named a retired mechanism to its replacement in the same commit
(CLAUDE.md 10.6).

### Phase 4: the new 16 + seasonal, and the store (animator 2 weeks; engineer 1 week)

Section 4D. Marketplace gets a Throwables shelf that sells premium items
(diamonds) next to the existing packs; VIP page lists the VIP-only set as a
benefit; the picker's purchase sheet deep-links to both. Seasonal items
enabled by `season` with a date window.

### Phase 5: sound library final, verification, launch (2 weeks, all streams)

Every placeholder cue replaced; loudness-normalised; the library size and the
preload policy measured on a real phone; 60 fps at eight simultaneous
throws on a 375 px device; every darkroom sheet reviewed by Dan; the free
allowance decision (section 6) applied; telemetry: throws per item per day,
per-tier, purchase conversions, and a `throw_render_failed` counter (the
animation law's "a paid throw must never vanish silently").

Total: about ten weeks with one animator, six to seven with two. The
engineering is roughly five weeks of the ten and is front-loaded.

---

## 6. Dan's decisions

None of these blocks phase 0. All of them shape phase 1.

1. **Art direction.** (a) A consistent 2D cartoon set drawn for animation,
   like the reference, or (b) animation built around the 48 existing 3D
   renders as hero layers. Recommendation: (a) for characters and emoticons
   (a 3D still cannot wink, chew or cry), (b) is acceptable for the objects
   if you want to keep the renders you approved on 2026-08-20; mixing the two
   will read as two sets. Either way the animator needs the answer first.

2. **Tiers and prices.** Section 4 proposes, across the 75 items: free 43,
   VIP-only 18, premium 14 (+4 seasonal premium). Every emoticon is free,
   because that is the social layer and the reference gives every account
   100 of them. The reference gates bear, cake, missile, rat, poop as VIP
   and locks two "Special". Premium prices need a number in diamonds; the
   existing `feature_pricing` table is the place. Recommendation: 25-50
   diamonds for a premium throwable, seasonal 15, and a "Premium Pack" bundle
   of all eight at a discount.

3. **Free allowance for everyone.** PokerBros shows "Free emojis left: 100"
   on a fresh account. Ours: VIP 500/month, non-VIP zero (one diamond each),
   and `throw_usage` says nobody throws. Recommendation: 30 free per month
   for every member, 500 for VIP, then packs, then diamonds. This is what
   players are owed in future, so it is yours (CLAUDE.md 10.9).

4. **Copy or differentiate the reference's signature gags.** The beats are
   ideas and ideas are not protected; the ART is. Every asset here is drawn
   by us. The question is whether the 2-7 trash can, the cheating rat and the
   card shark should be built beat-for-beat (parity) or with our own twist.
   Recommendation: parity on the beats, our own art and our own sounds, and
   at least one twist per gag so a side-by-side is not identical (the rat
   flips OUR club's card back; the 2-7 can is stamped with the club logo).

5. **Sound sourcing.** (a) License a commercial SFX library for the
   mechanical cues (cork, register, clinks, booms) and COMMISSION the
   character vocalisations (laughs, bray, squeaks, sobs, bawk, "bravo"); or
   (b) commission everything. The knockout's K.O. call note already says the
   platform wants a real voice; a two-hour session with a voice actor covers
   every vocalisation in section 4E. Recommendation: (a). Do you want your
   own voice on any of them?

6. **Avatar reaction.** The reference never moves the avatar; everything is
   in the overlay. Ours flinches the seat and shakes the table for heavy
   items. Recommendation: drop the seat flinch and the table shake for
   throwables (keep both for the knockout, which is a different event), so
   the target's cards, stack and badge never move while a hand is live.

7. **Words on the felt.** The reference shows one label in 31 throws ("GOOD
   LUCK"). Ours puts captions on ten items and speaks seventeen lines.
   Recommendation: keep GOOD LUCK, STRIKE!, IT'S GOOD!, OOF and TILT as
   captions (they are the joke), retire the rest with the TTS.

---

## 7. Files this plan creates or retires

```
added    docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md      (this)
added    docs/throwables/pokerbros-reference-video-1.md            (measured)
added    docs/throwables/pokerbros-reference-video-2.md            (measured)
phase 0  src/throwables/spec.ts, src/throwables/specs/*.ts, manifest
phase 0  src/components/table/ThrowablePlayer.tsx (+ .css, small)
phase 0  src/services/ThrowableSoundService.ts (rewritten), ThrowableVoice.ts (deleted)
phase 0  supabase/migrations/<reserved>_throwable_catalog_and_ownership.sql
phase 0  scripts/dev/preview-throwable.mjs
phase 0  tests/throwables-always-play.law.test.ts, tests/unit/throwableSpecs.test.ts,
         tests/unit/throwableEntitlement.test.ts, docs/laws.d/<law>.md
phase 3  deleted: ThrowableSignatures.css, the physics/impact half of
         ThrowAnimation.css, ThrowableCutout.ts, the still-render path in
         ThrowableImage.tsx (the picker keeps a poster frame from the Lottie)
public   public/throwables/<id>.json (80), public/sounds/throwables/<cue>.webm (~150)
```
