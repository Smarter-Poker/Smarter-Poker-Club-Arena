# PokerBros throwables - frame catalogue for "PB THROWABLE 1.MOV"

Source: 2704 frames at 30 fps (90.1 s), 220x480 px portrait. Frame N is at (N-1)/30 s.
Frames: `outputs/thr/f1/NNNNN.jpg`. Audio RMS per frame: `r1.npy`. Coarse sheets: `c1_*.jpg`.

Status: COMPLETE - 12 hero throws + 1 villain emoticon catalogued (every table-visible frame
of the video was swept with per-seat frame differencing; no other throw exists in it).

## Index of every throw in this video (final)

| #   | Item (picker tile)                  | Thrower -> target seat            | Dialog (frames) | Spawn -> clean (frames)                   | Life     | Section  |
| --- | ----------------------------------- | --------------------------------- | --------------- | ----------------------------------------- | -------- | -------- |
| 1   | Water gun (r1c1)                    | hero -> Briz3300 (upper-right)    | 100-162         | 174 -> 281                                | 3.57 s   | THROW 1  |
| 2   | Beer mug (r1c2)                     | hero -> Bjorno (upper-left)       | ~305-344        | 349 -> 485                                | 4.57 s   | THROW 2  |
| 3   | Fireworks (r1c3)                    | hero -> Tmomma (top)              | ~501-535        | 564 -> 654 (no flight; 0.93 s pre-delay)  | 3.0 s    | THROW 3  |
| 4   | Doge (r1c4)                         | hero -> bmtboy (middle-left)      | ~679-763        | 770 -> 900                                | 4.37 s   | THROW 4  |
| 5   | Horseshoe (r1c5)                    | hero -> dtudiamond (middle-right) | ~931-968        | 975 -> 1088+ (end hidden)                 | >= 3.8 s | THROW 5  |
| 6   | Trash can (r2c1) = the "2-7" gag    | hero -> Tmomma (top)              | ~1095-1206      | 1215 -> 1349                              | 4.50 s   | THROW 6  |
| V1  | Thinking-face emoticon (smiley tab) | Bjorno (villain) -> dtudiamond    | none            | 1307 -> 1391+ (end hidden)                | >= 2.8 s | V1       |
| 7   | Red boxing glove (r2c2)             | hero -> Bjorno (upper-left)       | ~1395-1437      | 1448 -> 1509                              | 2.07 s   | THROW 7  |
| 8   | Hand with dice (r2c3)               | hero -> Briz3300 (upper-right)    | ~1675-1715      | 1716 -> 1895+ (end hidden)                | >= 5.6 s | THROW 8  |
| 9   | Champagne bottle + flutes (r2c4)    | hero -> bmtboy (middle-left)      | ~1897-2015      | 2020 -> 2126+ (end hidden; audio to 2162) | ~4.7 s   | THROW 9  |
| 10  | White clown/snowman face (r2c5)     | hero -> Tmomma (top)              | ~2127-2185      | 2187 -> 2253                              | 2.23 s   | THROW 10 |
| 11  | Brown bear head (r3c1)              | hero -> Briz3300 (upper-right)    | ~2285-2349      | 2359 -> 2493                              | 4.50 s   | THROW 11 |
| 12  | Gold trophy statuette (r3c2)        | hero -> bmtboy (middle-left)      | ~2516-2588      | 2595 -> 2704+ (video ends)                | >= 3.7 s | THROW 12 |

"rNcM" = row N, column M of the Character Emojis grid (5 columns). The "Free emojis left"
counter reads 100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89 on the twelve successive
dialogs: one free emoji is consumed per throw.

## Common mechanics (what every hero throw shares)

1. TAPS: tap the target seat -> PROFILE dialog opens (~3 frames scale-in, grid drawn 6 frames
   after the tap) -> tap a tile in the grid -> the dialog closes at once (2-3 frames) and the
   throw starts. Two taps total. The Confirm button is never used for a throw (it belongs to
   the Tag / settings part of the dialog). No selection highlight on the tapped tile.
2. SPAWN: the projectile scales in ON THE THROWER'S AVATAR (on the hero's face / upper-left of
   the face), from ~0 to full size over 4-8 frames (133-267 ms). Exception: fireworks draw
   nothing at the thrower.
3. FLIGHT: straight line from thrower avatar to target avatar, constant speed, 4-12 frames
   (typically 6-10 frames = 200-333 ms; ~20-30 px/frame on a 220 px wide frame, i.e. roughly
   1 avatar diameter per frame). No arc, no easing visible, no motion trail, no scale change.
   Rotation: only the dice tumble; the bear wobbles slightly; everything else keeps its
   orientation (bottles/mugs stay upright).
4. ARRIVAL: most payloads use a "shrink to a dot at the target centre (1-3 frames), then pop up
   with a damped bounce (overshoot ~1.1-1.3x, sometimes an undershoot, settle in ~4-8 frames)".
   Seen on: water gun, doge, bear, villain emoticon, trash can (dot then 9-frame pause). The
   beer mug lands with a small overshoot only; the champagne bottle and trophy simply arrive.
5. PAYLOAD: drawn OVER the target avatar (never under it). Typical payload size 1.0-1.5 avatar
   diameters; sunburst/rays/bursts reach 2-2.4 diameters. The avatar itself never shakes,
   tints, scales or changes; the seat's name plate and stack stay visible.
6. LIFE: about 4.5 s from spawn for the "full" throwables (beer 4.57, trash 4.50, bear 4.50,
   doge 4.37, champagne ~4.7 by audio, water gun 3.57); shorter gags exist (glove 2.07 s,
   clown 2.23 s, fireworks 3.0 s); the dice hand ran >= 5.6 s.
7. END: everything vanishes in ONE frame (hard cut) - water gun (splat cut, then the gun
   shrinks out over 4 frames), beer, doge, trash, glove, bear, clown (this one fades over 8
   frames). No lingering residue on any of them.
8. AUDIO: nothing at spawn, during flight, or at the landing-dot for any throwable (the only
   landing sounds are the horseshoe tick and the doge bass boom). Sounds are tied to the
   payload beats and are typically 5-11 frames (170-370 ms) LATER than the visual beat they
   belong to. Sounds may outlast the picture by 0.5-1.1 s (fireworks, doge, bear).

## Picker (PROFILE dialog with the emoji grid)

Opened by tapping any opponent's seat. Layout, top to bottom (see `z_picker127.jpg`,
`z_picker_top127.jpg`, `z_picker1195.jpg`, `z_t6_dialog.jpg`):

- Title "PROFILE", orange round X close button top-right.
- Avatar, name (e.g. "Briz3300"), "ID:2732738", "Club:"; on the right a chat-bubble icon with
  a green check and a bell icon with a green check (chat / notification toggles).
- A dark "Tag" text field.
- Two round stat badges: "Newbie / ? Playstyle" and "Normal / ? Heat Index".
- "Free emojis left: N" and "Free time banks left: 1" (N decrements by one per throw).
- A pill tab bar with four icons: clock (Recently Used), a boxed sparkle icon (Character
  Emojis), a "V" (VIP Emojis), a smiley (Emoticons). The yellow highlight marks the section
  currently scrolled into view (it moves from the clock to the boxed icon when the user
  scrolls past the Recently Used row - the tabs are section anchors, not filters).
- "Recently Used": one row of up to 5 tiles, most recent on the LEFT, empty at the start of
  the video, filling up as throws are made (water gun; beer, water gun; ...; champagne, hand
  with dice, ...).
- "Character Emojis": a 5-column grid of square dark tiles. Rows in order:
  - row 1: water gun, beer mug, fireworks, doge, horseshoe
  - row 2: trash can, red boxing glove, hand with dice, champagne bottle + flute, white
    clown/snowman face with red nose
  - row 3: brown bear head, gold trophy statuette, peach (butt), strawberry cake, red-tipped
    rocket
  - row 4: banana peel, stack of dollar bills, purple mouse with a card, poop, tomato
  - row 5: blue shark, grey donkey/mule head, chicken/rooster, black bomb, red rose
  - row 6: green fish (single tile)
    (rows 5-6 verified from video 2's reference crops `ref_picker_rows3-5_f2_1045.jpg`,
    `ref_picker_rows5-6_f2_3469.jpg`; in video 1 row 5 is only ever partly visible.)
- Below that (video 2 refs): "VIP Emojis" section - tiles with a gold "V" corner badge (bear,
  cake, rocket, mouse, poop, ... duplicates of grid items gated as VIP) - and an "Emoticons"
  section (yellow faces: crying, laughing, surprised-with-flag, heart-eyes, thinking, ...)
  with a "Special" sub-section of LOCKED tiles (padlock badge: a blue energy ball, a sloth).
  None of the VIP/locked tiles are used in video 1. No prices are shown anywhere in video 1.
- Yellow "Confirm" button at the bottom (not used for throwing).
- The whole dialog body scrolls vertically (drag), including the tab bar and the counters.

Throwables shown in the grid but NEVER thrown in this video: peach, cake, rocket, banana,
money, mouse, poop, tomato, shark, donkey, chicken, bomb, rose, fish (14 of the 26 tiles),
plus every VIP tile and every Emoticon/Special tile from the hero's side.

## IMPORTANT AUDIO NOTE

The recording is SILENT for frames 1-373 (0.00-12.43 s). The first audible sample is at f374.
So throw 1 (water gun) has no audio in this video; every later throw does. Audio "x" values below
are RMS relative to the whole-video median RMS (0.0007); "peak" is the loudest frame in that hit.
Loudest sound in the whole video: f2047 (RMS 0.643, the champagne cork pop).

## Seat coordinates (220x480 frame, first hand f1-1090)

| Seat          | Player                     | Avatar centre (x,y) | Avatar diameter |
| ------------- | -------------------------- | ------------------- | --------------- |
| top           | Tmomma (rabbit)            | (110, 92)           | ~30 px          |
| upper-left    | Bjorno (dog with hat)      | (35, 160)           | ~30 px          |
| upper-right   | Briz3300 (man, purple cap) | (180, 158)          | ~30 px          |
| middle-left   | bmtboy (eagle)             | (24, 272)           | ~30 px          |
| middle-right  | dtudiamond (red bull)      | (192, 272)          | ~30 px          |
| bottom (hero) | SunBum45 (bald man)        | (110, 358)          | ~30 px          |

Everything below is measured in these 220x480 pixels; multiply by (your avatar diameter / 30)
to scale.

## Throws

### THROW 1 - Water gun (hero SunBum45 -> Briz3300, upper-right seat)

Dialog: opens f100 (tap on Briz3300 seat at ~f97), grid fully drawn f106, tile tapped ~f159,
dialog closes f160-162 (content blanks at f160, gone at f163). The dialog closes on the tile
tap itself; the Confirm button is NOT used for throwing. No selection highlight is visible on the
tapped tile. Launch frame L = f174 (first frame the gun exists). Frames at 30 fps; ms = (f-174)/30.

| Beat                  | Frames  | ms from L | What is on screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn at thrower      | 174-177 | 0-100     | Gun pops in at the HERO avatar, upper-left of the face, centre (106,346); scales up from ~0.45 to 1.0 in 4 frames (pixel count 21 -> 95). Final size ~22x20 px = 0.7 avatar widths. Barrel points up-right (~35 deg), pink tank, blue body, yellow trigger.                                                                                                                                                                                                                                                                                                            |
| Flight                | 178-186 | 133-400   | Straight line from (112,335) to (171,162), 9 frames = 300 ms, constant speed (~21 px/frame in y, ~7 px/frame in x). NO rotation, NO scale change, NO arc, NO trail. Sampled centres: 178 (112,335) 179 (118,314) 180 (125,293) 181 (135,272) 182 (144,252) 183 (152,232) 184 (157,209) 185 (163,183) 186 (171,162).                                                                                                                                                                                                                                                    |
| Land: shrink to dot   | 187-188 | 433-467   | Gun collapses to a ~4 px dot at the target avatar centre (180,150). 2 frames.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Pop-up with overshoot | 189-191 | 500-567   | Gun re-grows from the dot: 189 ~0.3x, 190 ~0.8x, 191 ~1.1x (overshoot), 192 settles at 1.0x. Centre (174,156), bbox x166-195 y144-170 (~30x26 px, about 1 avatar width), sitting over the lower-left quadrant of the avatar, barrel aimed at the face.                                                                                                                                                                                                                                                                                                                 |
| Hold / aim            | 192-196 | 600-733   | Gun holds still at (174,156).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Pull back             | 197-201 | 767-900   | Gun slides down-left to (157,194) over 5 frames (dx -17, dy +38) so the barrel is ~15 px below-left of the face, still aimed up-right at it.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SQUIRT / impact       | 202     | 933       | In ONE frame a cyan (RGB ~ 120,255,240) water stream appears from the barrel to the face and a cyan splat blob covers the face. The blob has two white round "eyes" (white discs with black pupils, ~4 px) so it reads as a water-blob face. Splat bbox x150-206 y125-185 (~56x60 px = 2.0 avatar diameters), centred (180,153) = exactly on the avatar; it fully covers the avatar and the "Fold" badge above it.                                                                                                                                                     |
| Squirt loop           | 202-277 | 933-3433  | 76 frames = 2.53 s. The splat is not static: spike/droplet count pulses with period ~8 frames (cyan pixel area cycles 340 -> 490 -> 340; largest at f205-206, 215-216, 227, 235-236, 245-246, 257, 263, 270-271, 277). Droplets fly out radially up to ~12 px beyond the blob. The stream from the barrel is continuous. The gun jitters +-4 px (recoil) in step with the pulses; its centre wanders between (152,181) and (163,212). The avatar itself does NOT shake, tint or scale; it is simply hidden under the splat. Name plate and stack remain visible below. |
| Splat off             | 278     | 3467      | Splat and stream vanish in a single frame (hard cut, no fade). Avatar visible again, unchanged. Gun still at (163,212).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Gun shrink-out        | 278-281 | 3467-3567 | Gun scales down in place over 4 frames (pink area 46 -> 37 -> 28 -> 18 -> 0), gone at f281.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Clean                 | 281+    | 3567      | Seat fully clean. Nothing lingers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

TOTAL: 107 frames = 3.57 s from spawn to clean (174 -> 281). From dialog close (f162) to clean:
119 frames = 3.97 s. No on-screen text, counter, chat line or screen-wide effect. Nothing at
the thrower's seat after f177.

Audio: NONE - the recording has no audio until f374.

Reference frames: spawn 174-177; flight 180, 183, 186; dot 187; overshoot 191; settled 194;
pull-back 199; first squirt 202; loop peak 206 / trough 210; last splat 277; shrink 279-280.
Reference crops: `ref_watergun_f1_171-276.jpg`, `ref_watergun_impact_f1_201-276.jpg`,
`z_t1_flight.jpg`, `z_t1_arrive.jpg`, `z_t1_impact.jpg`, `z_t1_fade.jpg`.

### THROW 2 - Beer mug (hero SunBum45 -> Bjorno, upper-left seat)

Dialog: opens ~f305 (tap on Bjorno), shows "Free emojis left: 99" (decremented by throw 1) and
the water gun now sits in "Recently Used". Tile tapped ~f342, dialog gone at f345.
Launch frame L = f349 (first frame the mug exists). ms = (f-349)/30.

Mug sprite: upright glass mug, orange-amber beer, white foam head, handle on the right.
Full-size mug is ~17x24 px = 0.6 x 0.8 avatar diameters.

| Beat               | Frames  | ms from L | What is on screen                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn at thrower   | 349-354 | 0-167     | Mug pops in at the HERO avatar, upper-left of the face (~(100,345)), scaling up from tiny to full over 6 frames. Upright, no rotation.                                                                                                                                                                                     |
| Flight             | 355-364 | 200-500   | Straight line, upright (no spin, no arc, no scale change, no trail) from (112,354) to (45,162), 10 frames = 333 ms, constant ~22 px/frame in y, ~8 px/frame in x. Beer-core centres: 355 (112,354) 356 (109,343) 357 (101,321) 358 (93,298) 359 (85,276) 360 (77,253) 361 (69,231) 362 (61,208) 363 (53,185) 364 (45,162). |
| Land               | 364-366 | 500-567   | Lands on the right-centre of the Bjorno avatar (avatar centre (35,160)); 365-366 a small scale overshoot (~1.1x) then 1.0x. No shrink-to-dot on this one (unlike the gun).                                                                                                                                                 |
| Mug 1 slides right | 365-385 | 533-1200  | Mug 1 drifts right along the avatar's right edge: x 42 -> 57 (f375) -> 68 (f385), y ~156-161. ~1.3 px/frame. It ends up just outside the avatar's right edge.                                                                                                                                                              |
| Mug 2 spawns left  | 376-378 | 900-967   | A second identical mug pops in on the LEFT side of the avatar at (18,163) (tiny at 376, full size at 378, overshoot 378, settle 379). Now two mugs flank the avatar, 47 px apart, both slightly tilted inward (~10 deg), foam heads at y~148.                                                                              |
| Hold apart         | 379-390 | 1000-1367 | Both mugs hold, small bob (+-2 px).                                                                                                                                                                                                                                                                                        |
| Swing in to clink  | 391-396 | 1400-1567 | Both mugs swing inward AND upward (3-4 px/frame): L 20->31, R 65->49, y 162->154. They meet over the avatar's forehead at f395-396 forming a "V" (rims touching, bases apart).                                                                                                                                             |
| CLINK splash       | 396-411 | 1567-2067 | White foam spray erupts upward from the touching rims: spray top at y=134 (f396), y=127 (f398 = 25 px above the mug rims, ~0.8 avatar diameters), a plume of 8-12 white droplets. Peak 398-401, dissipating 404-411.                                                                                                       |
| Clinked hold       | 412-420 | 2100-2367 | Mugs stay in the V, centres L(31,152) R(50,152), 19 px apart. Foam blobs sit at the rims (y 139-146).                                                                                                                                                                                                                      |
| Ease apart         | 420-440 | 2367-3033 | Mugs slowly separate and settle lower: L 28->22, R 53->60, y 153->155/160.                                                                                                                                                                                                                                                 |
| Rest pose          | 440-484 | 3033-4500 | Two mugs flanking the avatar (centres (22,155) and (60,160), 38 px apart), foam on both, avatar face visible between them. Static.                                                                                                                                                                                         |
| Off                | 485     | 4533      | Both mugs vanish in ONE frame (hard cut, no fade, no shrink). Seat clean.                                                                                                                                                                                                                                                  |

The avatar never shakes, tints or scales; the mugs overlap its left and right thirds and the
clink covers its top edge. The "Raise" badge above the avatar is partly covered by the foam.
TOTAL: 137 frames = 4.57 s from spawn to clean (349 -> 485); 141 frames from dialog close.
No text, no counter, no chat line, no screen-wide effect.

Audio (first audible throw; relative to whole-video median RMS):

- f373-379: soft "pop" (peak 40x at f376, centroid ~1.9 kHz). Coincides with mug 2 spawning (f376). No sound at launch or on the flight/landing of mug 1 (f349-366 is at 3x = background).
- f406-446: the CLINK. Loud glassy chime with ~6 rattles: f407 (427x, the video's 2nd-loudest hit, centroid 3.9 kHz), f411 (252x), f418-419 (112x), f421 (184x), f425 (122x), f429 (123x), then a ring-down to f446 (1.3 s long). It starts 11 frames (367 ms) AFTER the visual rim contact (f395-396) and 8 frames after the spray peak; i.e. the sound trails the picture by ~0.35 s.
- f453-462 (45x) and f483-485 (82x) are GAME sounds (a bet chip sliding at f454-466, cards dealt at f481-489), not part of the throwable.

Reference frames: spawn 349-353; flight 358, 361, 363; land 364-366; mug 2 pop 376-378; apart 385;
swing 393-395; clink+spray 398, 401; V hold 412; rest 460; last 484; clean 485.
Reference crops: `ref_beer_flight_f1_350-372.jpg`, `ref_beer_impact_f1_364-486.jpg`,
`z_t2_flight.jpg`, `z_t2_impact_a.jpg`, `z_t2_impact_b.jpg`, `z_t2_clink.jpg`.

### THROW 3 - Fireworks (hero SunBum45 -> Tmomma, top seat)

Dialog: opens ~f501 (tap on Tmomma), "Free emojis left: 98", Recently Used now shows water gun
and beer. Tile tapped ~f533, dialog gone at f536. NOTHING is drawn for 28 frames (f536-563):
no object leaves the thrower, nothing crosses the table (verified frame-diff and a 3x zoom on
the hero seat: hero seat is untouched for the whole throw). The effect spawns AT the target.
Launch frame L = f564 (first spark visible). ms = (f-564)/30. Avatar centre (110,92).

Structure: TWO waves. Wave 1 = three rockets one after another (blue, magenta, yellow-orange),
each with a rising spark trail then a round particle burst. Gap. Wave 2 = three rockets rise
TOGETHER and burst together (blue left, white-yellow top-centre, magenta right).

| Beat                       | Frames  | ms from L | What is on screen                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rocket 1 trail             | 564-570 | 0-200     | A thin cyan/white spark (1-2 px wide, ~6 px tall streak with a bright head) rises at the avatar's lower-right, x~126, from y~120 to y~89. ~5 px/frame.                                                                                                                                                                                                                                                      |
| Burst 1 (blue)             | 571-585 | 233-700   | f571 a 4 px cyan dot at (128,89); 572-573 a small square-ish glow; 574-579 expands to a round blue particle burst, bbox x115-140 y78-104 (25x26 px = 0.85 avatar), centred (128,89) = just right of the avatar's ear, overlapping its right third. Peak density 577-580 (blue area 370-387 px). Fade 581-585 (area 286 -> 11), gone f586. Lifetime 15 frames.                                               |
| Rocket 2 trail             | 574-580 | 333-533   | Purple spark rises at the avatar's LEFT (x~85) from y~110 to ~70 while burst 1 is still up.                                                                                                                                                                                                                                                                                                                 |
| Burst 2 (magenta)          | 581-596 | 567-1067  | f581 dot at (85,66) above-left of the head; expands 582-587 to bbox x69-106 y41-89 (~35 px across = 1.2 avatar), centred (87,73); covers the "Fold" badge and the avatar's left half. Peak 587-589 (area ~535), fade 590-596, gone 597. 16 frames.                                                                                                                                                          |
| Rocket 3 trail             | 589-594 | 833-1000  | Yellow-white spark rises at the avatar's RIGHT (x~128) from y~95 to ~60.                                                                                                                                                                                                                                                                                                                                    |
| Burst 3 (yellow -> orange) | 595-616 | 1033-1733 | f595-599 a bright yellow dot/small glow at (~113,50); 600-604 expands to bbox x104-134 y40-73 (~30x33 px, 1.0 avatar) centred (117,55), above-right of the head, partly clipped by the top of the table area. Colour shifts yellow (600) -> orange (604) -> brown-orange embers (608-616) as it fades. Gone f617. 22 frames.                                                                                |
| Gap                        | 617-625 | 1767-2033 | Nothing on screen (9 frames).                                                                                                                                                                                                                                                                                                                                                                               |
| Wave 2 trails              | 626-633 | 2067-2300 | THREE sparks rise simultaneously: cyan at x~95 (left of avatar), white-yellow at x~112 (centre, above the head), purple at x~128 (right). From y~100 to ~75 over 8 frames.                                                                                                                                                                                                                                  |
| Wave 2 bursts              | 634-641 | 2333-2567 | f634 three dots; f635-636 three small glows; 637-641 they expand together: BLUE centred (87,80) bbox x74-106 y63-96 (32x33); WHITE-YELLOW centred (108,62) bbox x94-125 y45-79 (31x34) with a white-hot core (x96-124,y65-78); MAGENTA centred (131,80) bbox x117-146 y63-97 (30x34). Group bbox x73-146 y45-99 = 73x54 px (2.4 avatar widths), fully covering the avatar and the Fold badge. Peak 639-641. |
| Wave 2 hold + fade         | 642-653 | 2600-2967 | Colours darken and desaturate (blue -> teal, magenta -> purple, yellow -> orange-brown), alpha falls 642-653; core gone 649, last embers 653.                                                                                                                                                                                                                                                               |
| Clean                      | 654     | 3000      | Seat clean.                                                                                                                                                                                                                                                                                                                                                                                                 |

Particles: each burst is a dense round cloud of ~100-200 small dots (2 px) with a brighter
core, no ring outline, no streaks/tails, no gravity droop; edges are soft. The avatar does
NOT shake, tint or scale - bursts are drawn on top of it with additive-looking brightness.
No text, counter or chat line.
TOTAL: 90 frames = 3.0 s from first spark to clean (564 -> 654). From dialog close: 118
frames = 3.93 s including the 0.93 s silent pre-delay.

Audio (relative to median RMS):

- f564-589: rising WHISTLE (bright, centroid 5.3-5.6 kHz) swelling from 1x at f564 to 177x at
  f577, decaying to 7x by f588. It starts on the very first spark frame and peaks as burst 1
  reaches full size.
- f590-612: crackling BANG cluster, low-mid centroid 1.1-1.4 kHz: f590-591 (265x), f595
  (289x), f597 (263x), f600 (248x), f604 (244x), f612 (460x - loudest hit of wave 1). Roughly
  one bang every 4-5 frames (130-170 ms). Bang 1 lands 9 frames after burst 2 opened; bangs
  at 595/597/600/604 bracket burst 3; f612 lands during burst 3's ember fade.
- f613-634: rumble tail 25-60x (no visual) bridging the gap and wave 2's trails.
- f635-687: wave 2 barrage: f635 (42x), f639 (469x), f641 (268x), f643 (566x = loudest of this
  throw, RMS 0.406, 2nd loudest in the whole video), f647-651 sustained 277-388x, f654 (276x),
  f659-663 (150-200x), then a rumble decaying to silence at f688. Wave 2's first big bang
  (f639) is 5 frames (170 ms) after the bursts start opening (f634).
- Sound outlasts the picture by 34 frames (1.1 s): visual clean f654, audio ends f687.

Reference frames: trail 566, 569; burst 1 open 571-574, full 578, fade 584; burst 2 full 588;
burst 3 open 598, full 602, embers 612; wave-2 trails 629, 632; wave-2 pop 634-636;
wave-2 full 640; fade 646, 651; clean 654.
Reference crops: `ref_fireworks_flight_f1_538-576.jpg`, `ref_fireworks_bursts_f1_571-616.jpg`,
`ref_fireworks_wave2_f1_624-654.jpg`, `ref_fireworks_launchcheck.jpg`, `z_t3_burst_a.jpg`,
`z_t3_burst_b.jpg`, `z_t3_hero.jpg` (proves nothing at the thrower).

### THROW 4 - Doge (hero SunBum45 -> bmtboy, middle-left seat)

Dialog: opens ~f679 (tap on bmtboy), "Free emojis left: 97", Recently Used = water gun, beer,
fireworks. Tile tapped ~f761, dialog gone f764. Launch frame L = f770. ms = (f-770)/30.
Target avatar centre (24,272) (eagle). This is a THREE-part gag: the projectile is a pair of
pixel-art "deal with it" sunglasses, the payload is a Doge head that replaces the avatar,
then the glasses re-appear on the Doge and a sunburst fires behind it.

| Beat                    | Frames  | ms from L | What is on screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Glasses on the THROWER  | 770-775 | 0-167     | Black pixel-art sunglasses (8-bit "thug life" shades) fade/scale in ON THE HERO'S EYES, centre (110,337) (hero avatar centre (110,358); the glasses sit on the eye line). Grow from ~10 px to ~24 px wide over 6 frames. Slight tilt (~-10 deg, left lens higher).                                                                                                                                                                                                                  |
| Flight                  | 776-781 | 200-367   | Glasses fly in a straight line from (102,333) to (27,262), 6 frames = 200 ms, ~17 px/frame (fast). No spin, no scale change. Centres: 776 (102,333) 777 (88,319) 778 (71,303) 779 (54,288) 780 (40,271) 781 (27,262) = landed on the eagle's eyes.                                                                                                                                                                                                                                  |
| Glasses off, Doge pops  | 782-792 | 400-733   | f782 glasses vanish, avatar bare for 1 frame. f783 a 7 px Doge (Shiba head, tan/cream, black nose) appears at the avatar centre (26,265) and springs up with a DAMPED BOUNCE: width 783: 7 -> 784: 17 -> 785: 26 -> 786: 37 -> 787: 43 (overshoot ~1.3x) -> 788: 35 -> 789: 26 (undershoot) -> 790: 28 -> 792: 33 -> settles 795 at 30x33 px (bbox x12-42, y246-279). Final Doge is ~1.05 avatar diameters and completely covers the avatar (the "Fold" badge above stays visible). |
| Doge hold               | 793-812 | 767-1400  | Doge static over the seat, looking up-left.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Glasses slide onto Doge | 813-818 | 1433-1600 | The same pixel sunglasses re-enter from the upper-RIGHT of the seat (813 at ~(50,240), 814 (45,245), 815 (35,250)) and slide diagonally down-left onto the Doge's eyes (816 at (26,258)), settling 817-818. The glasses are ~24 px wide, slightly larger than the Doge's eye line.                                                                                                                                                                                                  |
| Sunburst on             | 819-823 | 1633-1767 | A radial YELLOW ray burst fades in BEHIND the Doge: ~16 straight triangular rays (yellow core, translucent edges) radiating from the Doge centre, span ~65-70 px (2.2 avatar diameters), reaching x 0-70, y ~232-300. Yellow pixel count 0 (f819) -> 23 (f822) -> 36 (f830). The Doge itself gets a warm yellow rim glow.                                                                                                                                                           |
| Sunburst hold           | 823-900 | 1767-4333 | Rays stay at full size; the ray pattern shimmers (individual ray angles/brightness change every few frames - it reads as a slow rotation / flicker). Doge + glasses static. 78 frames = 2.6 s.                                                                                                                                                                                                                                                                                      |
| Off                     | 901     | 4367      | Doge, glasses and rays all vanish in ONE frame (hard cut). Original avatar visible, unchanged. Seat clean.                                                                                                                                                                                                                                                                                                                                                                          |

No text / label / counter / chat line. Nothing remains at the hero after f775.
TOTAL: 131 frames = 4.37 s (770 -> 900). From dialog close: 137 frames = 4.57 s.

Audio:

- f781-809: a deep BASS BOOM (centroid ~150 Hz) starting exactly on the landing frame f781,
  peaking 202x at f787 (the Doge's overshoot frame), decaying over 29 frames (~1 s) to f809.
  Nothing at launch or during the glasses flight (f770-780 silent).
- f810-818: silence (Doge hold).
- f819-917: a MUSIC LOOP / beat, starting with the sunburst: hits every ~8 frames (267 ms):
  f821 (181x, bright 6.2 kHz), 829 (83x), 837 (195x), 845 (318x = loudest), 853 (259x), 861
  (117x), 868 (199x), 876 (145x), 884 (230x), 892 (136x), 899 (162x), 904, 908, 912 (170x);
  alternating bright hi-hat-like (4-6 kHz) and mid (1.2-1.8 kHz) hits, i.e. a 2-bar sting at
  ~112 BPM. It keeps playing 17 frames (0.57 s) after the visuals cut at f900, ending f917.

Reference frames: hero glasses 773, 775; flight 777, 779; landed 781; Doge pop 784, 786, 787
(overshoot), 789 (undershoot), 795 (settled); glasses slide 813-816; sunburst fade-in 820-822;
full 830, 850; last 900; clean 901.
Reference crops: `ref_doge_flight_f1_776-786.jpg`, `ref_doge_impact_f1_786-930.jpg`,
`ref_doge_label_f1_819-909.jpg`, `z_t4_flight.jpg`, `z_t4_impact_a.jpg`, `z_t4_impact_b.jpg`,
`z_t4_label.jpg` (shows there is NO floating text).

### THROW 5 - Horseshoe (hero SunBum45 -> dtudiamond, middle-right seat)

Dialog: opens ~f931 (tap on dtudiamond), "Free emojis left: 96", Recently Used = beer, water
gun, fireworks, doge (most recent first, 4 visible). Tile tapped ~f966, dialog gone f969.
Context: dtudiamond is ALL IN with cards face-up (10h 7c) above the avatar, so the seat has a
magenta "All In" badge and two exposed cards where the avatar normally is; the horseshoe lands
on top of them. Launch frame L = f975. ms = (f-975)/30. Target seat centre (192,272).

Sprite: 3D gold horseshoe, opening at the TOP (U shape), dark nail holes, ~20x19 px (0.65
avatar).

| Beat             | Frames       | ms from L  | What is on screen                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn at thrower | 975-981      | 0-200      | Horseshoe fades/scales in at the HERO avatar's upper-left, centre (106,352), from a dark tiny sprite (975) to full gold at 981 (bbox x100-118 y342-361).                                                                                                                                                                                                         |
| Flight           | 982-987      | 233-400    | Straight line, no spin, no scale change: 982 (110,349) 983 (127,332) 984 (144,315) 985 (161,298) 986 (177,281) 987 (190,267). 6 frames = 200 ms, ~24 px/frame. Lands on the seat centre.                                                                                                                                                                         |
| Float / bounce   | 987-1005     | 400-1000   | Horseshoe rises 12 px (y 267 -> 255 at f992-993) then sinks back (y 268 at f998), one soft bob of ~11 frames, then settles at (190,268) sitting over the top half of the seat (overlapping the "All In" badge and the top of the face-up cards).                                                                                                                 |
| Glow bloom       | 1010-1018    | 1167-1433  | Shading is lost: the horseshoe turns flat saturated yellow and blooms to ~1.4x (gold pixel area 135 -> 320), i.e. a glowing silhouette ~27x29 px.                                                                                                                                                                                                                |
| Text reveal      | 1019-1025    | 1467-1667  | "GOOD LUCK" (two lines, red-orange fill, gold-yellow outline, slight italic) grows out of the glowing horseshoe: tiny at 1019, half at 1020, near-full 1021, full with a big radial yellow RAY BURST behind it at 1022 (rays span ~45-70 px, bbox x172-216 y249-291), rays fading 1023-1024, gone 1025. Horseshoe itself is gone by 1021 (replaced by the text). |
| Text hold        | 1025-1088+   | 1667-3767+ | Text settles at ~30x22 px (bbox x180-209 y254-276), centred (194,265) = over the avatar/cards, with a faint yellow glow. Small pop on settle (1024-1026).                                                                                                                                                                                                        |
| Clovers          | 1031-1038    | 1867-2100  | Four green four-leaf clovers (~8 px) grow out from behind the text corners: first upper-right and left (1031-1034), all four (upper-left, upper-right, lower-left, lower-right) by 1037, static from 1038.                                                                                                                                                       |
| End              | not observed |            | The label is still fully present at f1088, the last frame before the next profile dialog covers the table (f1089-1206). It is gone when the table is next visible (f1207). Visible duration >= 114 frames (3.8 s) from spawn; by analogy with throws 1/2/4 the full life is ~4.5 s.                                                                              |

The avatar does not react (no shake/tint). The seat's game elements (All In badge, cards)
stay drawn under the effect. No counter or chat line; the only text is the GOOD LUCK label.

Audio:

- f975-983: silent (spawn and flight make no sound).
- f984-986: short bright tick/whoosh (82x at f986, centroid ~3 kHz) on landing.
- f999-1009: metallic CLANK (386x at f999, 256x at f1000, ring-down to f1009), 12 frames after
  landing = exactly at the bottom of the bob (f998). This is the horseshoe hit.
- f1010-1041: near silence (the glow, text reveal and clovers are SILENT - no sound at 1019-1025).
- f1042-1056: CORRECTED 2026-09-06 by transcription + pitch tracking: this is a RECORDED MALE
  VOICE saying "GOOD LUCK" (34.74-35.16 s; periodicity 0.6-0.8, F0 137 Hz on "good" rising to
  200-210 Hz on "luck", 420 ms), landing ~600 ms after the label pops (~300 ms after it settles,
  allowing for the recording's audio lag). It is the throwable's cue, not the card deal. Treat
  the horseshoe as: tick on landing + one clank on the bob + a spoken "Good luck" after the
  label.

Reference frames: spawn 977, 981; flight 983, 985; land 987; bob top 993; bob bottom 998;
bloom 1012, 1016; text 1020, 1022 (rays), 1026; clovers 1034, 1038; hold 1060, 1088.
Reference crops: `ref_horseshoe_f1_975-1088.jpg`, `z_t5_flight.jpg`, `z_t5_impact.jpg`,
`z_t5_flip.jpg`, `z_t5_clover.jpg`.

### THROW 6 - Trash can (= the "2-7" gag) (hero SunBum45 -> Tmomma, top seat)

CORRECTION to the preliminary table: the "27" and the "trash can" are ONE throwable. The
trash can is the projectile; the payload is a 2 and a 7 (worst starting hand) popping out of
the can, a swearing speech-bubble, then the can comes back, opens, swallows the cards, closes
and attracts flies.

Dialog: opens ~f1095 (tap on Tmomma), "Free emojis left: 95" (the horseshoe cost one), Recently
Used = horseshoe, doge, fireworks, beer, water gun. During this dialog (f1140-1176) the user
SCROLLS the whole dialog body up, which pushes the Recently Used row off the top and reveals
grid rows 3-4 fully and row 5 partially (see the Picker section). Tile tapped ~f1204 (row 2
col 1 = trash can), dialog gone f1207.
A NEW HAND starts at the same moment (blinds posted f1207-1213, hole cards dealt f1224-1245
as blue card backs flying from the centre to every seat, "New" badge on the hero, "SB" on
Tmomma). Those blue cards are GAME animation, not part of the throw.
Launch frame L = f1215. ms = (f-1215)/30. Target avatar centre (110,92).

Sprite: grey metal trash can with a lid and a green recycling symbol, ~22x26 px (0.8 avatar).

| Beat              | Frames    | ms from L | What is on screen                                                                                                                                                                                                           |
| ----------------- | --------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn at thrower  | 1215-1220 | 0-167     | Can fades/scales in at the hero's upper-left (~(100,340)), tiny -> full over 6 frames. Upright.                                                                                                                             |
| Flight            | 1221-1229 | 200-467   | Straight UP the centre line (both seats are at x~110): y ~335 -> ~105 in 9 frames (~26 px/frame). No spin, no scale. At 1229 the can's lid is visible at the bottom of the avatar (arriving from below).                    |
| Land              | 1230      | 500       | Can drawn full size (1.1 avatar) centred on the avatar for ONE frame.                                                                                                                                                       |
| Vanish / pause    | 1231-1239 | 533-800   | Can disappears completely; avatar bare for 9 frames.                                                                                                                                                                        |
| Card "2" pops out | 1240-1244 | 833-967   | A red "2" (2 of hearts, white card, red pip) appears tiny and rotated at the avatar's upper-left (1240), grows and rights itself while sliding down (1241-1243), lands at the avatar's lower-left at 1244. Card ~14x20 px.  |
| Card "7" pops out | 1245-1248 | 1000-1100 | A black "7" (7 of spades) appears at the upper-right (1245), grows and settles at the lower-right next to the 2 (1247-1248). The pair "2 7" now sits over the avatar's lower half, overlapping the seat's dealt hole cards. |
| Swear bubble      | 1253-1289 | 1267-2467 | A small white speech bubble (~10x8 px) with black grawlix scribbles (#$%!) pops at the avatar's upper-right (~(130,58)): 1253 small, 1254 overshoot, 1255 settle; static until f1289, gone f1290.                           |
| Cards shift right | 1270-1275 | 1833-2000 | The 2 and 7 shrink slightly and slide right (~8 px) to make room.                                                                                                                                                           |
| Can returns       | 1274-1278 | 1967-2100 | The can rises from below the avatar's left side, growing to ~1.2 avatar (bbox ~x90-115 y70-105), centred (103,95), lid on.                                                                                                  |
| Lid opens         | 1281-1290 | 2200-2500 | Lid tilts up and flies to the upper-left of the can (rotating ~-60 deg), hovering there.                                                                                                                                    |
| Cards jump in     | 1291-1304 | 2533-2967 | The 2 rises and rotates (1291-1295), hangs over the can mouth (1296-1297), the 7 follows rotating (1298-1301); both fall into the can 1302-1304 (only their edges visible above the rim).                                   |
| Lid closes        | 1305-1309 | 3000-3133 | Lid drops back onto the can (1305 tilted, 1309 seated).                                                                                                                                                                     |
| Flies             | 1320-1349 | 3500-4467 | Small grey specks / stink lines (2-3 px) buzz around the left of the can lid (a few dark dots moving each frame). Can otherwise static.                                                                                     |
| Off               | 1350      | 4500      | Can and flies vanish in ONE frame (hard cut). Seat clean.                                                                                                                                                                   |

TOTAL: 135 frames = 4.50 s (1215 -> 1349). From dialog close: 143 frames. The avatar does not
react. The only text is the grawlix bubble. Note the "2 7" cards are throwable graphics, NOT
the seat's real cards (the real hole cards are the blue backs dealt at the same time).

Audio (mixed with game sounds - the deal):

- f1224-1235: three bright swishes (108x @1226, 116x @1230, 99x @1235; centroid 5.3-5.5 kHz),
  ~4-5 frames apart = the GAME dealing hole cards (blue backs fly f1224-1245). Not the throw.
- f1238-1248: two low-mid SLAPS, 304x @1242 and 287x @1247 (centroid 1.1 kHz) = the "2" (1240- 1244) and the "7" (1245-1248) popping out. Likely throwable audio (different timbre and 3x
  louder than the deal swishes).
- f1252-1257: faint tick (17x) at the bubble pop (f1253).
- f1262-1280: rising rattle/whoosh 42x -> 186x (peak f1274) -> 52x: the can rising back
  (1274-1278). Ends f1280.
- f1289-1304: SILENCE while the lid opens and the cards jump in.
- f1305-1309: metallic clank 96x @1305 (centroid 2.8 kHz) = lid closing.
- f1324-1341: loud 300x @1325-1327 plus 143x @1331 (2.5 kHz). This coincides with the FLIES
  appearing (f1320) but also with a villain emoticon landing on the right seat (f1317-1325, see
  V1 below) and the hero's action buttons appearing; attribution ambiguous - most likely the
  emoticon's landing sound (see V1).
- f1354-1367: 85x hum (1 kHz) - probably game/turn sound.

Reference frames: spawn 1217, 1220; flight 1223, 1226; arrive 1229-1230; bare 1235; "2" 1240,
1242, 1244; "7" 1246, 1248; bubble 1254; shift 1272; can rise 1275, 1278; lid open 1284, 1288;
cards in 1293, 1297, 1301, 1304; lid closed 1309; flies 1325, 1340; last 1349; clean 1350.
Reference crops: `ref_27_flight_f1_1218-1242.jpg`, `ref_27_impact_f1_1230-1290.jpg`,
`ref_trash_end_f1_1282-1304.jpg`, `z_t6_flight.jpg`, `z_t6_arrive.jpg`, `z_t6_impact.jpg`,
`z_t6_cloud.jpg` (bubble), `z_t6_end.jpg`, `z_t6_end2.jpg`.

### V1 - Villain emoticon: "thinking face" (Bjorno, upper-left seat -> dtudiamond, middle-right seat)

Not thrown by the hero; no dialog on screen. This is an item from the picker's 4th (smiley)
tab. It shows the generic arrival animation from a villain's seat.

| Beat            | Frames       | What is on screen                                                                                                                                                                                                                               |
| --------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn           | 1307-1309    | Yellow emoji pops in at Bjorno's avatar, centre (40,150) -> (49,163), growing 5 -> 74 px area.                                                                                                                                                  |
| Flight          | 1309-1316    | Straight line to dtudiamond: 1309 (49,163) 1310 (66,177) 1311 (86,192) 1312 (105,206) 1313 (124,220) 1314 (143,234) 1315 (163,248) 1316 (182,263). 8 frames, ~24 px/frame, no spin, no scale change.                                            |
| Shrink to dot   | 1317-1319    | Collapses to a ~5 px dot at the target centre (195,275).                                                                                                                                                                                        |
| Pop with bounce | 1320-1325    | 1320 small, 1321 ~1.1x, 1322 ~1.3x overshoot (bbox x183-209 y251-276), 1323 ~1.1x, 1324 dip ~0.8x, 1325 settle ~1.0x. Same damped bounce as the Doge.                                                                                           |
| Animated hold   | 1326-1391+   | The emoji is ANIMATED: 1326-1333 neutral face, a hand rises from the bottom-left; 1334-1341 brows knit into a frown/pout; 1342-1391 hand on chin, eyebrows moving ("hmm"/thinking loop). Size ~26x26 px (0.9 avatar), covering the avatar face. |
| End             | not observed | Still present at f1391; the hero's next dialog covers the table f1393-1437; the seat is clean at f1440. Visible >= 85 frames (2.8 s).                                                                                                           |

Audio: the loud hit at f1324-1327 (300x, 2.5 kHz) and f1331 (143x) line up with this
emoticon's bounce landing (f1322-1325) and probably belong to it (a "boing"/pop), rather
than to the trash can's flies.
Reference crops: `ref_villain_smiley_f1_1300-1320.jpg`, `z_v1_smiley_a.jpg`, `z_v1_smiley_b.jpg`.

### THROW 7 - Red boxing glove (hero SunBum45 -> Bjorno, upper-left seat)

Dialog: opens ~f1395 (tap on Bjorno), "Free emojis left: 94", Recently Used = trash can,
horseshoe, doge (+ more off-crop). Tile tapped ~f1435 (row 2 col 2), dialog gone f1438.
Launch frame L = f1448. ms = (f-1448)/30. Target avatar centre (35,160) (Bjorno, dog).

Sprite: red boxing glove (white cuff) ~12x13 px during flight; on impact it is a glove ON A
FOREARM (tan sleeve) that punches in from the side, ~25 px long.

| Beat                            | Frames    | ms from L | What is on screen                                                                                                                                                                                                                                                                                         |
| ------------------------------- | --------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn at thrower                | 1448-1452 | 0-133     | Glove fades/scales in ON the hero's face, centre (110,356), area 6 -> 46 px.                                                                                                                                                                                                                              |
| Flight                          | 1453-1462 | 167-467   | Straight line up-left, no spin/scale: 1453 (106,343) 1454 (98,321) 1455 (90,297) 1456 (83,276) 1457 (74,251) 1458 (66,229) 1459 (59,208) 1460 (51,185) 1461 (43,162) 1462 (40,153). 10 frames, ~24 px/frame. Ends at the avatar centre.                                                                   |
| Punch 1 (from LEFT)             | 1463-1467 | 500-633   | Glove re-appears on a forearm entering from the LEFT edge of the seat (1463 at (24,165)), thrusts into the avatar's left cheek (1464-1466, red area 109 -> 186), with an orange-yellow star-shaped IMPACT FLASH around the fist at 1465-1467 (~25 px, covering the avatar's left half).                   |
| Debris 1                        | 1468-1471 | 667-767   | Fist withdraws (red gone 1468); 8-12 small red/orange particles spray outward left and right of the avatar, fading by 1471.                                                                                                                                                                               |
| Punch 2 (from RIGHT)            | 1472-1476 | 800-933   | Forearm enters from the RIGHT edge (1472 at (55,157)), fist lands on the right cheek 1474-1476 (red area 140-146) with a yellow flash at 1475-1476.                                                                                                                                                       |
| Debris 2                        | 1477-1479 | 967-1033  | Fist out, particles spray to the right, fade.                                                                                                                                                                                                                                                             |
| Punch 3 (from LEFT)             | 1480-1483 | 1067-1167 | Forearm from the LEFT, fist at (30,150), flash at 1483.                                                                                                                                                                                                                                                   |
| Debris 3                        | 1484-1487 | 1200-1300 | Particles, fist out.                                                                                                                                                                                                                                                                                      |
| Punch 4 - FINISHER (from RIGHT) | 1488-1499 | 1333-1700 | Forearm from the RIGHT, fist at (49,152) 1489-1491; big yellow flash 1492; then 1493-1499 a large jagged yellow-white LIGHTNING / shockwave burst spreads to the right of the seat (spikes reaching ~x 80, i.e. 45 px from the face, 1.5 avatar diameters), decaying 1500-1503 into small sparkle specks. |
| Fist held                       | 1500-1509 | 1733-2033 | The glove stays pressed on the right cheek (centre (57,154)); a few sparkle specks drift right (1504-1507).                                                                                                                                                                                               |
| Off                             | 1510      | 2067      | Glove and specks vanish in ONE frame (hard cut). Avatar unchanged (no bruise, no tint). Seat clean.                                                                                                                                                                                                       |

Rhythm: hits at 1465, 1474, 1483, 1492 = every 9 frames (300 ms), alternating L/R/L/R, 4th
is the finisher. The avatar does NOT shake or recoil (the dog's face stays put; only the
overlays move). No text. TOTAL: 62 frames = 2.07 s (1448 -> 1509) - the shortest throwable
in this video. From dialog close: 72 frames = 2.4 s.

Audio:

- f1448-1462 (spawn + flight): silent. (A 40-80x hum at f1428-1455, centroid ~600 Hz, starts
  during the dialog and is unrelated - probably the game's turn timer.)
- Four THWACKS, each ~3 frames, exactly on the flash frames: f1465-1467 (128x @1466, centroid
  1.3 kHz), f1473-1476 (94x @1474, 2.5 kHz), f1481-1483 (80x), and the finisher as a triple
  f1486-1488 (82x) / f1490-1491 (113x) / f1493-1494 (80x). Silence from f1497 (the held fist
  and cut-out are silent).

Reference frames: spawn 1450, 1452; flight 1455, 1458, 1461; punch 1 1464-1466; debris 1469;
punch 2 1474-1476; punch 3 1481-1483; finisher 1490-1492, lightning 1494, 1497; held 1505;
last 1509; clean 1510.
Reference crops: `ref_glove_f1_1452-1510.jpg`, `z_t7_flight.jpg`, `z_t7_impact.jpg`.

### THROW 8 - Hand with dice (hero SunBum45 -> Briz3300, upper-right seat)

(The preliminary table's "event 9 - to verify" - it is a real throw, previously uncatalogued.)
Dialog: opens ~f1675 (tap on Briz3300), "Free emojis left: 93". Tile tapped ~f1715 (row 2
col 3, the hand holding dice), dialog gone f1716. Launch frame L = f1716. ms = (f-1716)/30.
Target avatar centre (180,158). Game context: hero has 9c 7d face-up at the bottom, Briz3300
is BB; no game animation interferes.

Sprite in flight: a PAIR of white dice with black pips, stuck together, ~12x9 px; they TUMBLE
(orientation changes every frame) during the flight - the only rotating projectile in this
video. Payload: a skin-tone hand (open, fingers up, the dice cupped at its base), ~1.3 avatar
tall, covering the avatar's LEFT half.

| Beat             | Frames       | ms from L | What is on screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spawn at thrower | 1716-1719    | 0-100     | Dice pop in at the hero's face (~(112,340)), growing over 4 frames.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Flight           | 1719-1726    | 100-333   | Straight line from (112,332) to (~178,150): top edge y 335 (1717) 321 (1718) 279 (1720) 258 (1721) 237 (1722) 214 (1723) 193 (1724) 172 (1725) 154 (1726); ~21 px/frame. Dice tumble as they go (visible pip faces change each frame). No scale change.                                                                                                                                                                                                                                                                        |
| Land / swap      | 1725-1727    | 300-367   | Dice arrive at the avatar's lower-left (1725-1726), then vanish; at 1727 the HAND is already drawn at ~60 percent of the skin-pixel count it will have at 1730 (a 3-4 frame scale-in), centred on the avatar's left edge (~(163,155)).                                                                                                                                                                                                                                                                                         |
| Hand loop        | 1727-1895+   | 367-5967+ | The hand shakes the dice in a loop. Phases seen: 1727-1744 hand upright, fingers up, dice cupped at the base (lower-left of the avatar); 1745-1754 hand dips ~4 px; 1755-1764 hand turns side-on / palm-down and jiggles (dice visible under it); 1765-1779 back upright; 1780-1798 hand held lower with the dice showing under the fingers; 1799-1814 shake again; 1815-1895 the same open-hand / dip / shake pattern repeats (cycle roughly 40-45 frames). The avatar's right half, "BB" badge, name and stack stay visible. |
| End              | not observed |           | Still running at f1895 (last table frame before the next dialog, f1896-2015); seat is clean at f2016. Visible life >= 169 frames = 5.6 s, i.e. LONGER than the 4.5 s of the other throwables.                                                                                                                                                                                                                                                                                                                                  |

No text, no particles, no avatar reaction.

Audio: spawn, flight and landing are SILENT (f1716-1754 flat). Then bright dice-rattle
CLICKS (centroid 6.2-7.0 kHz, each 1-2 frames) in bursts that follow the hand's shakes:

- burst 1: f1755 (25x), 1759 (69x), 1763 (54x), 1767 (28x), 1771 (27x), 1777 (9x) - six clicks
  ~4 frames apart during the palm-down jiggle (1755-1777);
- burst 2: f1799 (80x), 1803 (29x);
- burst 3: f1865 (45x), 1870 (89x), 1877 (50x), 1881 (39x), 1887 (8x).
  Nothing else. So the sound design is "rattling dice" only while the hand visibly shakes.

Reference frames: spawn 1717-1719; flight 1721, 1723, 1725; hand in 1727-1730; upright 1735;
dip 1750; palm-down shake 1758, 1762; low hold 1790; shake 1805; late loop 1850, 1890.
Reference crops: `z_e9.jpg` (overview), `z_t8_flight.jpg`, `z_t8_impact.jpg`, `z_t8_end.jpg`,
`z_t8_chk.jpg` (seat clean at f2016).

### THROW 9 - Champagne (bottle + two flutes) (hero SunBum45 -> bmtboy, middle-left seat)

Dialog: opens ~f1897 (tap on bmtboy), "Free emojis left: 92". The user scrolls the grid (rows
2-5 visible, second tab highlighted as the section indicator). Tile tapped ~f2013 (row 2 col 4,
bottle + flute icon), dialog gone f2016. Launch frame L = f2020. ms = (f-2020)/30.
Target avatar centre (24,272) (eagle). Game: bmtboy has "Call" badge; at f2100 the game
changes it to "Fold" and mucks his two cards (blue backs fly to the centre f2101-2109) and pot
chips fly f2113-2125 - all GAME animation, ignore.

Sprite: tall dark-green champagne bottle, gold label and gold foil neck, ~10x32 px (1.1 avatar
TALL, 1/3 avatar wide), always upright.

| Beat                  | Frames    | ms from L | What is on screen                                                                                                                                                                              |
| --------------------- | --------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn at thrower      | 2020-2027 | 0-233     | Bottle fades/scales in at the hero's face (left of centre, ~(100,340)), tiny -> full over 8 frames. Upright.                                                                                   |
| Flight                | 2028-2033 | 267-433   | Straight line up-left to bmtboy, staying UPRIGHT (no rotation), no scale change: ~(95,325) 2028 -> (~70,290) 2030 -> (~45,262) 2032 -> (24,265) 2033. 6 frames, ~25 px/frame.                  |
| Stand                 | 2033-2043 | 433-767   | Bottle stands centred on the avatar (x~24), base at the avatar's bottom, neck reaching up through the "Call" badge (bottle spans y~150-185 in the 3.6x crop, i.e. ~y 232-270 in frame). Still. |
| CORK POP              | 2044-2048 | 800-933   | White puff at the neck tip (2044-2045), then a white foam JET erupts straight up: 2046 puff ~8 px, 2047-2048 jet 20-25 px above the neck, with fine white droplets.                            |
| Foam jet              | 2049-2066 | 967-1533  | Continuous white stream/mist from the neck reaching ~40 px above (to y~195), thin, slightly arcing right, droplets spraying sideways at the top.                                               |
| Jet detaches          | 2067-2077 | 1567-1900 | Stream thins to a wiggly white thread that lifts off the neck, rises and fades; gone 2078.                                                                                                     |
| Bottle rests          | 2078-2088 | 1933-2267 | Bottle standing, no spray.                                                                                                                                                                     |
| Bottle -> flute morph | 2089-2094 | 2300-2467 | Bottle turns translucent (2090-2091) and cross-fades into ONE yellow champagne flute (~8x20 px) at the same spot, which grows to full size by 2094.                                            |
| Single flute          | 2094-2100 | 2467-2667 | One full flute centred on the avatar.                                                                                                                                                          |
| Second flute          | 2101-2109 | 2700-2967 | A second flute fades in on the LEFT; both tilt inward into a "V" with rims touching at the top-centre (2105-2114).                                                                             |
| Clink splash          | 2115-2118 | 3167-3267 | Small yellow droplets jump up from the touching rims (2116-2118).                                                                                                                              |
| Ease apart            | 2118-2125 | 3267-3500 | Flutes swing outward to upright positions flanking the avatar (left flute ~x10, right ~x38), a few droplets above each.                                                                        |
| Fade-out begins       | 2126      | 3533      | Left flute becomes translucent (fade-out starting). The next dialog covers the table from f2127; seat is clean when next visible (f2185). Life ~3.6-4.5 s.                                     |

No text. Avatar does not react. TOTAL >= 107 frames (3.57 s) visible; audio (below) runs to
f2162, i.e. 4.73 s from spawn, which is the likely full length.

Audio:

- f2020-2043: silent (spawn, flight, standing).
- f2047: CORK POP - RMS 0.643 = 896x median, THE LOUDEST SOUND IN THE VIDEO (centroid 2.5 kHz),
  decaying over 10 frames to f2056. It lands 3 frames after the first visual puff (f2044).
- f2062-2126: continuous fizz/hiss at 35-60x (centroid ~1.7 kHz) for 65 frames = 2.2 s, running
  from the foam jet through the morph and the cheers.
- f2127-2128: glass CLINK 161x (4.5 kHz) - 10 frames after the visual rim contact (f2116), the
  same ~0.35 s lag seen on the beer clink; tail to f2148.
- f2149-2156: two softer clinks (61x, 91x, 4.4-4.8 kHz) while the table is hidden by the dialog.
  Silence from f2162.

Reference frames: spawn 2022, 2026; flight 2029, 2031; stand 2036; pop 2044, 2046, 2048; jet
2052, 2060; thread 2070, 2075; rest 2082; morph 2090-2093; one flute 2097; two flutes 2106,
2112; splash 2117; apart 2122; fade 2126.
Reference crops: `z_t9_flight.jpg`, `z_t9_impact.jpg`, `z_t9_morph.jpg`, `z_t9_glasses.jpg`,
`z_t9_clink.jpg`.

### THROW 10 - White clown / snowman face (hero SunBum45 -> Tmomma, top seat)

Dialog: opens ~f2127 (tap on Tmomma), "Free emojis left: 91", Recently Used = champagne, hand
with dice, ... Tile tapped ~f2183 (row 2 col 5, the white face with the red nose), dialog gone
f2186. Launch frame L = f2187. ms = (f-2187)/30. Target avatar centre (110,92). Game context:
Tmomma had folded, so her avatar is drawn DIMMED (mean brightness 48) until the hand ends at
f2236, when the game restores it to normal (mean 119-126). That brightening is the GAME, not
the throwable.

Sprite: a white snowman/clown figure - round white head with a red ball nose and two black
eye dots, small white body below - ~15x24 px (0.8 avatar).

| Beat             | Frames    | ms from L | What is on screen                                                                                                                                                                                                                                                                                                         |
| ---------------- | --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn at thrower | 2187-2193 | 0-200     | Figure fades/scales in on the hero's face (~(112,349)), tiny at 2187, full at 2193.                                                                                                                                                                                                                                       |
| Flight           | 2194-2205 | 233-600   | Straight UP the centre line (both seats at x 110-113): centre y 349 (2194), 325, 302, 278, 254, 230, 206, 182, 158, 134, 110, 86 (2205) = exactly 24 px/frame, 12 frames. No spin, no scale, no arc.                                                                                                                      |
| Land             | 2205      | 600       | Full figure drawn over the avatar centre (113,86), nose at (108,88).                                                                                                                                                                                                                                                      |
| SPLAT            | 2206-2210 | 633-767   | f2206 the white figure vanishes (only the red nose left at (109,82)) - 1 frame; f2207 a white powder PUFF appears ABOVE the head (bbox x103-120 y62-83); 2208-2210 it grows into a tall plume x100-121 y62-98 (22x36 px, 0.7 avatar wide, 1.2 avatar tall), covering the avatar's top half and the "Fold" badge above it. |
| Spray            | 2210-2216 | 767-967   | White specks spray sideways and upward from the plume, up to ~12 px outside it, fading by 2217. Meanwhile the RED NOSE falls: (110,87) 2210 -> (112,102) 2214 -> (114,106) 2228 (comes to rest at the avatar's chin, 1 px/frame).                                                                                         |
| Cloud lingers    | 2217-2245 | 1000-1933 | A puffy cartoon smoke cloud (white, soft edges, ~210 px area) sits over the upper half of the avatar and above it; its lobes slowly shift. Red nose rests at the bottom until f2236, then disappears.                                                                                                                     |
| Fade             | 2246-2253 | 1967-2200 | Cloud fades out (white area 220 -> 92 at 2248 -> 50 at 2250 = only the white rabbit avatar itself).                                                                                                                                                                                                                       |
| Clean            | 2254      | 2233      | Seat clean (no residue, no tint).                                                                                                                                                                                                                                                                                         |

TOTAL: 67 frames = 2.23 s (2187 -> 2253). No text. From dialog close: 68 frames.

Audio:

- f2187-2210: silent (spawn, flight, splat start).
- f2211-2216: a soft POOF 198x @2211 (centroid 3.9 kHz), 5 frames after the splat frame (2206),
  tail to f2224 (7-25x).
- f2236 (52x) and f2242-2249 (18-29x): coincide with the hand ending / avatar un-dimming - game
  sounds, not the throwable.

Reference frames: spawn 2189, 2192; flight 2197, 2201, 2204; land 2205; splat 2207, 2209;
spray 2212, 2215; nose falling 2214; cloud 2225, 2240; fade 2248, 2251; clean 2254.
Reference crops: `z_t10_flight.jpg`, `z_t10_impact.jpg`.

### THROW 11 - Brown bear head (row 3 col 1) (hero SunBum45 -> Briz3300, upper-right seat)

(The preliminary table's "event 12 - to verify" - it is a real throw, previously uncatalogued.)
Dialog: opens ~f2285 (tap on Briz3300), "Free emojis left: 90". Grid scrolled to rows 2-5.
Tile tapped ~f2347 (row 3 col 1, the brown bear/boar head), dialog gone f2350.
A NEW HAND is being dealt at the same time (blue card backs fly to every seat f2354-2375, hero
receives 6s 3c face-up at f2366-2378) - GAME animation, ignore.
Launch frame L = f2359. ms = (f-2359)/30. Target avatar centre (180,158).

Sprite: cartoon brown bear head (round ears, big black nose, wide grin with tongue), the same
art as the picker tile; in flight ~22x22 px (0.75 avatar); as the payload it is ~1.5 avatar
diameters and fully covers the avatar and the "SB" badge.

| Beat                | Frames    | ms from L | What is on screen                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn at thrower    | 2359-2364 | 0-167     | Bear head fades/scales in ON the hero's face, centred (110,352), tiny -> ~0.75 avatar.                                                                                                                                                                                                                                                                        |
| Lift + flight       | 2365-2371 | 200-400   | It first lifts straight up above the hero's head (2365 at ~(100,330)), then flies in a straight line up-right: 2366 (~95,320) 2367 (~118,300) 2368 (~135,285) 2369 (~150,262) 2370 (~160,240) 2371 (~172,215). ~22 px/frame; a slight side-to-side tilt (+-10 deg wobble) but no full tumble; no scale change.                                                |
| Land, shrink to dot | 2372-2375 | 433-533   | Reaches the avatar's lower-left (2372), collapses to a dot (2373), invisible 2374-2375.                                                                                                                                                                                                                                                                       |
| Pop up              | 2376-2379 | 567-667   | Grows from the avatar centre: 2376 small, 2377 medium, 2378 large, 2379 full = ~1.5 avatar (bbox ~x160-205 y130-180). No overshoot bounce visible on this one.                                                                                                                                                                                                |
| Laugh loop          | 2380-2419 | 700-2000  | The bear face is ANIMATED: mouth opens and closes (wide grin with tongue 2380-2389, mouth working 2390-2399, wide 2400-2409, 2410-2419), head bobs +-2 px.                                                                                                                                                                                                    |
| Anger phase         | 2420-2493 | 2033-4467 | Expression changes: a RED anger mark (cross-shaped throbbing-vein symbol, ~8 px) appears at the top-right of the head at 2421-2423 and stays; the face flushes red (2424-2435), the mouth opens in a shout, the eyes fill with yellow sparkle/star highlights (2440 onwards), and the head trembles (alternating +-3 px tilt every 2-3 frames) until the end. |
| Off                 | 2494      | 4500      | Everything vanishes in ONE frame (hard cut). Avatar unchanged. Seat clean.                                                                                                                                                                                                                                                                                    |

TOTAL: 135 frames = 4.50 s (2359 -> 2493). No text, no particles, no avatar reaction.

Audio:

- f2357-2374: four bright card-deal swishes (~100-120x, 5.4-5.5 kHz) every 4-5 frames = GAME
  (hole cards being dealt). Ignore. Spawn and flight of the bear are silent (f2375-2381 flat).
- f2382-2405: LAUGH - rhythmic "ha-ha-ha" bursts every 3-4 frames (2382 146x, 2385 160x, 2388
  189x, 2391 210x, 2395 226x, 2398 206x, 2400-2401 214x), low-mid centroid 0.8-1.4 kHz,
  starting 3 frames after the head reaches full size.
- f2406-2411: breath (30-65x); f2412-2419: second laugh phrase (72-149x).
- f2420-2433: grumble / wind-up (45-187x) as the anger mark appears.
- f2434-2493: sustained ROAR / growl at 200-275x (peak 275x @2461, centroid 0.7-1.4 kHz) for
  60 frames = 2.0 s, i.e. the whole anger phase.
- f2494-2509: roar tail decaying 156x -> 13x; silence from f2510 (16 frames after the visual
  cut).

Reference frames: spawn 2361, 2364; lift 2365; flight 2367, 2369, 2371; dot 2373; pop 2377,
2379; laugh 2385, 2395, 2405, 2415; anger mark 2422; flush 2430; stars 2445; tremble 2470,
2490; last 2493; clean 2494.
Reference crops: `z_e12.jpg` (overview), `z_t11_flight.jpg`, `z_t11_impact.jpg`,
`z_t11_impact2.jpg`.

### THROW 12 - Gold trophy statuette (row 3 col 2) (hero SunBum45 -> bmtboy, middle-left seat)

Dialog: opens ~f2516 (tap on bmtboy), "Free emojis left: 89". Grid scrolled to rows 2-5. Tile
tapped ~f2587 (row 3 col 2, the gold Oscar-style statuette), dialog gone f2589.
Launch frame L = f2595. ms = (f-2595)/30. Target avatar centre (24,272) (eagle); the seat's
name plate carries the yellow "your turn" highlight box during this throw (game state).
The video ENDS at f2704 while the effect is still on screen.

Sprite: gold statuette (standing figure on a round base), ~8x22 px in flight, ~10x26 px as
payload (0.9 avatar tall, 1/3 avatar wide).

| Beat                      | Frames       | ms from L  | What is on screen                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn at thrower          | 2595-2601    | 0-200      | Statuette fades/scales in on the hero's face (~(100,345)), upright.                                                                                                                                                                                                                                                                                                  |
| Lift                      | 2602         | 233        | Moves up ~10 px above the hero's head.                                                                                                                                                                                                                                                                                                                               |
| Flight                    | 2603-2606    | 267-367    | Straight line up-left, upright, no spin: ~(95,330) 2603 -> (~60,300) 2604 -> (~45,265) 2605 -> (~32,245) 2606 (top-right of the avatar). Only 4 frames, ~30 px/frame - the fastest flight in the video.                                                                                                                                                              |
| Vanish + wisp             | 2607-2613    | 400-600    | Statuette disappears; a faint grey vertical wisp (smoke-like, ~3 px wide) rises above the avatar's left shoulder, up to ~35 px above the head.                                                                                                                                                                                                                       |
| Spotlight beam            | 2614-2633    | 633-1267   | A bright vertical golden-white BEAM grows above the avatar's left side (x~18-26): 2614-2617 thin and dim, 2618-2623 brighter with a small statuette silhouette forming at its base, 2624-2633 full brightness - a light shaft ~8 px wide and ~50 px tall (top at y~200), the statuette now solid at its base standing on the avatar's left shoulder (base at y~278). |
| Beam fade                 | 2634-2643    | 1300-1600  | Beam narrows and dims to a thin glow, gone by 2644. Statuette stays.                                                                                                                                                                                                                                                                                                 |
| Statuette hold + sparkles | 2644-2704+   | 1633-3633+ | Gold statuette stands at the avatar's left side (~x 20-30, y 252-278), overlapping the left third of the face. Small white sparkle glints flash near its head at 2675-2677 and 2685-2687 (and presumably on).                                                                                                                                                        |
| End                       | not in video |            | Still present at the last frame (f2704). Visible >= 110 frames = 3.67 s; by analogy the full life is ~4.5 s.                                                                                                                                                                                                                                                         |

No text, no avatar reaction (the eagle stays as-is; the yellow name-plate box is the game's
turn indicator).

Audio:

- f2595-2607: silent (spawn, flight, vanish).
- f2608-2623: soft low swell 17x -> 44x (centroid ~730 Hz) under the wisp/early beam.
- f2624-2635: bright shimmering CHIME 106x -> 189x @2633 (centroid 4.8 kHz) - the beam at full
  brightness. Onset f2624 = 10 frames after the beam first appears (2614), on the frame the
  beam reaches full brightness.
- f2643-2660: second, fuller fanfare/chime rising 93x -> 228x @2654 (centroid 2.2 kHz) as the
  beam fades and the statuette is left standing.
- f2661-2704: sustained soft shimmer 25-90x to the end of the video (sparkles).

Reference frames: spawn 2597, 2600; lift 2602; flight 2604, 2605; arrive 2606; wisp 2610;
beam 2616, 2620, 2626, 2632; fade 2638, 2642; hold 2650, 2670; sparkle 2676, 2686; last 2704.
Reference crops: `z_t12_flight.jpg`, `z_t12_impact.jpg`.

## Appendix - reference crops produced during this pass (all in `outputs/thr/`)

Helper scripts: `strip.py` (zoomed frame strips: `python3 strip.py f1 START END STEP x0 y0 x1 y1 SCALE out.jpg COLS`),
`aud2.py` (per-frame RMS relative to the median + onset list + crude spectral centroid:
`python3 aud2.py START END`), `track.py` (colour-mask centroid tracker).

| File                                                                                           | Frames                | Crop (x0,y0,x1,y1) | Shows                                     |
| ---------------------------------------------------------------------------------------------- | --------------------- | ------------------ | ----------------------------------------- |
| z_layout50.jpg                                                                                 | 50                    | full               | seat layout, hand 1                       |
| z_layout1210.jpg                                                                               | 1210                  | full               | seat layout after the re-deal (unchanged) |
| z_picker127.jpg, z_picker_top127.jpg                                                           | 127                   | full / top half    | first PROFILE dialog, empty Recently Used |
| z_picker1195.jpg                                                                               | 1195                  | bottom half        | grid rows 1-4 after scrolling             |
| z_t6_dialog.jpg                                                                                | 1140-1206 step 6      | lower half         | the dialog scroll                         |
| z_counters.jpg                                                                                 | 520,700,950,1700,2300 | counter row        | "Free emojis left" 98/97/96/93/90         |
| z_t1_dialog.jpg, z_t1_tap.jpg                                                                  | 97-170, 152-166       | full / lower       | dialog open, tile tap, close              |
| z_t1_flight.jpg, z_t1_arrive.jpg, z_t1_impact.jpg, z_t1_fade.jpg                               | 163-310               | right seat         | water gun                                 |
| z_t2_flight.jpg, z_t2_impact_a/b.jpg, z_t2_clink.jpg                                           | 340-495               | left seat          | beer                                      |
| z_t3_flight.jpg, z_t3_hero.jpg, z_t3_burst_a/b.jpg                                             | 534-665               | top seat / hero    | fireworks                                 |
| z_t4_flight.jpg, z_t4_impact_a/b.jpg, z_t4_label.jpg                                           | 764-939               | middle-left        | doge                                      |
| z_t5_flight.jpg, z_t5_impact.jpg, z_t5_flip.jpg, z_t5_clover.jpg                               | 966-1095              | middle-right       | horseshoe                                 |
| z_t6_flight.jpg, z_t6_arrive.jpg, z_t6_impact.jpg, z_t6_cloud.jpg, z_t6_end.jpg, z_t6_end2.jpg | 1206-1359             | top seat           | trash can / 2-7                           |
| z_v1_smiley_a/b.jpg                                                                            | 1294-1461             | middle-right       | villain thinking emoticon                 |
| z_t7_flight.jpg, z_t7_impact.jpg                                                               | 1437-1526             | upper-left         | boxing glove                              |
| z_e9.jpg, z_t8_flight.jpg, z_t8_impact.jpg, z_t8_end.jpg, z_t8_chk.jpg                         | 1716-2021             | upper-right        | hand with dice                            |
| z_t9_flight.jpg, z_t9_impact.jpg, z_t9_morph.jpg, z_t9_glasses.jpg, z_t9_clink.jpg             | 2014-2141             | middle-left        | champagne                                 |
| z_t10_flight.jpg, z_t10_impact.jpg                                                             | 2184-2293             | top seat           | clown / snowman                           |
| z_e12.jpg, z_t11_flight.jpg, z_t11_impact.jpg, z_t11_impact2.jpg                               | 2348-2529             | upper-right        | bear                                      |
| z_t12_flight.jpg, z_t12_impact.jpg                                                             | 2586-2704             | middle-left        | trophy                                    |

Profile badges seen (they vary per player, not related to throwables): Playstyle = Newbie /
Table Hero / Loose Cannon; Heat Index = Normal / Extremely hot / Hot / Cold.
