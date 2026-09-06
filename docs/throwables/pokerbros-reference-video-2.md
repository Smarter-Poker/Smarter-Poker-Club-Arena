# PokerBros Throwables - Catalogue for Video 2 ("PB THROWABLE 2.MOV")

Source: 3912 frames at 30 fps (130.4 s), 220x480 px JPEG in `thr/f2/`.
Frame N is at (N-1)/30 s. All frame numbers below are 1-based file numbers.
Pixel coordinates are in the 220x480 frame (x right, y down). Avatars are
~40 px diameter circles; the frame is 220 wide, so 1 px = 0.45% of width.
Audio: `a2.wav` (22.05 kHz mono), `r2.npy` = per-frame RMS (index = frame-1).
The recording captured APP AUDIO ONLY: RMS is exactly 0.000 whenever no sound
effect is playing, so every non-zero run is a sound effect. Loudest frame in
the whole video = 0.453 (f3262, in throw 16); "rel" below = RMS / 0.453.

STATUS: COMPLETE for the 18 hero throws + 1 incoming. The picker inventory is in section 1.2 of THROWABLES-PREMIUM-ANIMATION-PLAN.md (verified from the crops ref*picker*_*f2*_.jpg).

## Table layout (6-max, same all video)

| seat          | player          | avatar            | centre (x,y) |
| ------------- | --------------- | ----------------- | ------------ |
| top           | Tmomma          | white rabbit      | (110, 92)    |
| upper-left    | Bjorno          | dog in red hat    | (40, 160)    |
| upper-right   | Briz3300 (SB)   | man's face, cigar | (180, 160)   |
| lower-left    | bmrboy          | eagle with trophy | (32, 280)    |
| lower-right   | drudiamond (BB) | bull              | (188, 280)   |
| bottom / hero | SunBum45        | man, folded 6-3   | (110, 358)   |

Every throw in this video is thrown BY the hero (SunBum45, bottom seat).

## 0. Throw windows located (from motion spikes = dialog open/close, verified on coarse sheets)

Pattern in this video: tap seat -> PROFILE dialog slides up (motion spike) ->
user picks item -> Confirm -> dialog closes (motion spike) -> item spawns on
the hero's head, holds, flies to the target.

| #   | dialog open | dialog close | throw window (frames) | notes                                                                    |
| --- | ----------- | ------------ | --------------------- | ------------------------------------------------------------------------ |
| 1   | 6           | 114          | 115-199               | egg -> Tmomma (top)                                                      |
| 2   | 200         | 279          | 280-361               |                                                                          |
| 3   | 362         | 432          | 433-567               |                                                                          |
| 4   | 568         | 661          | 662-759               |                                                                          |
| 5   | 760         | 851          | 852-980               |                                                                          |
| 6   | 981         | 1063         | 1064-1211             | picker rows 3-5 visible near f1045                                       |
| 7   | 1212        | 1309         | 1310-1409             |                                                                          |
| 8   | 1410        | 1483         | 1484-1580             |                                                                          |
| 9   | 1581        | 1654         | 1655-1784             |                                                                          |
| 10  | 1785        | 1874         | 1875-2035             |                                                                          |
| 11  | 2036        | 2126         | 2127-2264             |                                                                          |
| 12  | 2265        | 2334         | 2335-2428             |                                                                          |
| 13  | 2429        | 2497         | 2498-2605             |                                                                          |
| 14  | 2606        | 2684         | 2685-2865             |                                                                          |
| 15  | 2866        | 2994         | 2995-3053             |                                                                          |
| 16  | 3054        | 3142         | 3143-3246             |                                                                          |
| 17  | 3247        | 3340         | 3341-3440             |                                                                          |
| 18  | 3441        | 3662         | 3663-3838             | long dialog: picker browsing (rows 5-6, VIP tab, special tab, emoticons) |
| -   | 3839        | 3870         | end                   |                                                                          |

(to be verified/corrected per throw below)

## 1. Picker inventory

See THROWABLES-PREMIUM-ANIMATION-PLAN.md section 1.2 (26 character tiles, 5 VIP-badged, 14 emoticons, 2 locked Special; verified from ref_picker_rows3-5_f2_1045.jpg, ref_picker_rows5-6_f2_3469.jpg, ref_picker_vip_f2_3481.jpg, ref_picker_emoticons_f2_3505.jpg, ref_picker_special_f2_3547.jpg).

## 2. Throws

### Common mechanics observed (updated as throws are analysed)

- Dialog close: the PROFILE sheet disappears within 2-3 frames of Confirm
  (f114 -> gone by f117).
- Spawn/hold at thrower: the item pops in ON TOP of the thrower's avatar
  (upper-right of the hero's head, ~ (112, 325)), scale+fade-in over ~4
  frames, then HOLDS at full size for ~5 frames before launching.
  (throw 1: spawn f121, full size f125, launch f130 = 9 frames / 300 ms
  from first pixel to launch.)
- Flight: straight line from thrower's head to the target avatar centre,
  constant speed ~20 px/frame (~600 px/s in the 220x480 frame; ~46% of
  screen height in 11 frames = 367 ms for the bottom -> top throw).

### Throw 1 - EGG (picker row 3, col 3) - hero SunBum45 -> Tmomma (top seat)

Item identification: the picker tile is a plain brown/beige oval (looked like
a peach/bun at 220 px, but the flight object and the splat are unambiguously
an egg: brown shell, yellow yolk, white drips). "Recently used" in the next
dialog (f202) shows it first.

Beat table (launch frame f130 = 0 ms):

| frame   | ms            | what is on screen                                                                                                                                                                                                                                                                                                               |
| ------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 114-116 | -533          | Confirm tapped, PROFILE sheet closes (gone by f117)                                                                                                                                                                                                                                                                             |
| 117-120 | -433..-333    | table clean, nothing visible yet                                                                                                                                                                                                                                                                                                |
| 121     | -300          | egg first visible: tiny, translucent, top-right of hero's head (112,325)                                                                                                                                                                                                                                                        |
| 122-124 | -267..-200    | scale-in + fade-in to full size (egg ~12x15 px, tilted ~30 deg, long axis up-right)                                                                                                                                                                                                                                             |
| 125-129 | -167..-33     | HOLD at full size on hero's head, no motion                                                                                                                                                                                                                                                                                     |
| 130     | 0             | LAUNCH: egg jumps ~20 px up (centre ~ (108,300))                                                                                                                                                                                                                                                                                |
| 131     | 33            | (108,282)                                                                                                                                                                                                                                                                                                                       |
| 132     | 67            | (108,262)                                                                                                                                                                                                                                                                                                                       |
| 133     | 100           | (110,245)                                                                                                                                                                                                                                                                                                                       |
| 134     | 133           | (110,225)                                                                                                                                                                                                                                                                                                                       |
| 135     | 167           | (110,205)                                                                                                                                                                                                                                                                                                                       |
| 136     | 200           | (110,183)                                                                                                                                                                                                                                                                                                                       |
| 137     | 233           | (110,162)                                                                                                                                                                                                                                                                                                                       |
| 138     | 267           | (110,140)                                                                                                                                                                                                                                                                                                                       |
| 139     | 300           | (110,118) - egg at the bottom edge of the rabbit avatar                                                                                                                                                                                                                                                                         |
| 140     | 333           | (110,96) - egg over the avatar's face, still intact                                                                                                                                                                                                                                                                             |
| 141     | 367           | (108,78) - egg at the top of the avatar's head, intact: CONTACT                                                                                                                                                                                                                                                                 |
| 142     | 400           | CRACK: egg replaced in one frame by a splat sprite: orange-yellow yolk blob (~26 px wide, ~14 px tall) sitting on top of the head, cracked shell halves in it, and translucent white "egg white" drips running down over the avatar face to about the chin (~30 px). No particles, no burst, no flash, no avatar shake or tint. |
| 143-199 | 433-2300      | residue STATIC: identical sprite every frame (yolk cap + white drips); avatar still fully visible through the whites. No fade visible before the next dialog covers the seat at f200.                                                                                                                                           |
| 200     | 2333          | next PROFILE sheet slides up and hides the seat                                                                                                                                                                                                                                                                                 |
| 279-282 | (next window) | when the sheet closes the seat is CLEAN - residue ended somewhere between f199 and f279, i.e. residue life is >= 1.9 s and <= 4.6 s. (Throw with the same item later in the video, if any, will pin this.)                                                                                                                      |

Trajectory: straight vertical line (x stays 108-110), no arc, no spin
(the tilt stays the same in every flight frame), no scale change, no trail.
Speed 19-23 px/frame (mean 20.5), constant: no ease-in/ease-out.
Flight 11 frames (f130 -> f141) = 367 ms for 222 px.

Size: egg in flight ~12 x 15 px = ~30% of avatar diameter. Splat ~26 px wide
= ~65% of avatar diameter, drips cover ~75% of the avatar height.

Text / labels / counters: none on the table. Dialog "Free emojis left" was 88
before this throw and reads 87 in the next dialog (f202): one free emoji
consumed per throw.

Secondary elements: none (no chat line, no screen-wide effect).

Audio (r2.npy): digital silence f110-f150. Sound A: f151-f162, peak 0.050 at
f151 (rel 11%), second small peak f159 (0.038); Sound B: f172-f177, peak
0.018 (rel 4%). Quiet, short "crack/splat" plus a faint second tick.
NOTE the audio in this recording lags the picture: sound A starts 10 frames
(333 ms) after the visual crack at f142. Check against other throws before
trusting the absolute offset; treat "impact sound = crack frame" as the design
intent.

Best reference frames: hold f126; launch f130; mid-flight f135; contact f141;
crack f142; residue f150, f180. Crops: `v2_t1_hold2.jpg` (f117-130),
`v2_t1_flight.jpg` (f120-150), `v2_t1_impact_a.jpg` (f138-161),
`v2_t1_impact_b.jpg` (f162-210).

TOTAL: first pixel f121 to last visible residue >= f199 = >= 79 frames
(>= 2.6 s); flight portion 0.37 s.

### Throw 2 - CAKE (picker row 3, col 4: strawberry layer cake on a plate) - hero -> drudiamond (lower-right seat, bull)

Beat table (launch frame f293 = 0 ms):

| frame   | ms         | what is on screen                                                                                                                                                                                |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 279-281 | -467       | Confirm tapped, PROFILE sheet closes (gone by f282)                                                                                                                                              |
| 286     | -233       | cake first visible on hero's head (112,325): faint, small                                                                                                                                        |
| 287-288 | -200..-167 | scale/fade-in to full size (cake ~16 px wide x 14 px tall, plate + 2-tier pink/white cake, red berries on top)                                                                                   |
| 289-292 | -133..-33  | HOLD at full size on hero's head                                                                                                                                                                 |
| 293     | 0          | LAUNCH toward the lower-right seat (up and to the right)                                                                                                                                         |
| 294     | 33         | ~(147,325)                                                                                                                                                                                       |
| 295     | 67         | ~(160,318)                                                                                                                                                                                       |
| 296     | 100        | (166,311)                                                                                                                                                                                        |
| 297     | 133        | (184,294) - cake reaches the lower-left edge of the bull avatar: CONTACT                                                                                                                         |
| 298-300 | 167-233    | cake sits INTACT on the avatar, drifting up 3 px/frame (y 283 -> 276): 3-frame "press" before it breaks                                                                                          |
| 301     | 267        | SQUASH starts: cake tips forward, cream spreads (white pixel count 30 -> 149)                                                                                                                    |
| 302     | 300        | the PLATE is now face-on: a solid white disc ~22 px diameter (55% of avatar) centred on the avatar (195,269), cream/pink splatter bursts out around its top edge, strawberry sits at top of head |
| 303-307 | 333-467    | plate disc at rest, centre y 264-267; splatter (white + pink streaks) covers the top half of the avatar                                                                                          |
| 308-322 | 500-967    | plate SLIDES DOWN the avatar at ~1 px/frame (centre y 267 -> 280, 15 frames), splatter stays where it was                                                                                        |
| 323     | 1000       | plate fades (alpha ~50%)                                                                                                                                                                         |
| 324     | 1033       | plate gone. Residue = whipped-cream smear (white/pink, ~26 px wide) over the upper 60% of the avatar + red strawberry at the crown                                                               |
| 325-361 | 1067-2267  | residue STATIC, no fade visible                                                                                                                                                                  |
| 362     | 2300       | next PROFILE sheet slides up and hides the seat (residue life >= 2.0 s; seat is clean when the sheet closes at f432 => <= 4.4 s)                                                                 |

Trajectory: straight line from hero head to target avatar, 4 frames of flight
(f293 -> f297, ~85 px => ~21 px/frame, same constant speed as the egg).
No arc, no spin (cake stays upright, plate at the bottom), no scale change,
no trail.

Size: cake in flight ~16x14 px (40% of avatar); plate disc 22 px (55%);
cream smear ~26 px (65%). The plate covers the avatar face while it slides.
No avatar shake, tint or overlay other than the sprites.

Text / labels / counters: none. Free emojis 87 -> 86 (dialog at f364).

Audio (r2.npy):

- f282-f287: short bright click, peak 0.057 at f282 (rel 13%), centroid
  6-7 kHz, ~5 frames. The IDENTICAL sample (same 6-frame RMS shape) plays at
  f2339 right after the dialog closes at f2334 (throw 12) - it is a
  "spawn/whoosh-in" or Confirm sound tied to this item, NOT present for the
  egg. See throw 12.
- f298-f300: quiet low rumble (centroid 1.2 kHz, dominant 210-240 Hz),
  rms 0.010 -> 0.040 -> 0.025: an approach/whoosh leading into the hit.
- f301: MAIN SPLAT, peak sample 0.834, rms 0.147 (rel 32%), low-mid
  (dominant 240 Hz, centroid 3 kHz), decays over f302-f305 (0.096, 0.031,
  0.010, 0.003). Lands EXACTLY on the visual squash frame f301 (offset 0).
- f310-f311: second, smaller wet hit, rms 0.057 at f311 (rel 13%),
  centroid 3 kHz: plays 3 frames after the plate starts sliding (f308).
- silence from f319 on (plate fade at f323 is silent).

Best reference frames: hold f290; launch f293; flight f295, f296; contact
f297; press f299; squash f301; plate f302, f305; slide f312, f320; fade
f323; residue f330, f350. Crops: `v2_t2_flight.jpg` (f284-301),
`v2_t2_impact_a.jpg` (f300-323), `v2_t2_impact_b.jpg` (f324-362).

TOTAL: first pixel f286 -> plate gone f324 = 38 frames (1.27 s) of action;
residue >= 2.0 s after that.

### Throw 3 - MISSILE / AIRSTRIKE (picker row 3, col 5: red-and-white rocket with flame) - hero -> Tmomma (top seat)

This is a THREE-STAGE throwable: (A) a red crosshair reticle is thrown from
the hero to the target and locks on, (B) a missile dives in from OFF-SCREEN
(top edge), (C) fireball -> smoke cloud that hides the avatar for ~1 s.
Total on-screen time f437 -> f557 = 121 frames = 4.0 s. Nothing lingers.

Beat table (reticle launch f446 = 0 ms):

| frame   | ms         | what is on screen                                                                                                                                                                                                                                                                             |
| ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 432-434 | -467       | Confirm, PROFILE sheet closes (gone by f435)                                                                                                                                                                                                                                                  |
| 437-440 | -300..-200 | faint red crosshair fades in on the hero's head (108,340); fully opaque by f441                                                                                                                                                                                                               |
| 441-445 | -167..-33  | HOLD: red reticle ~14 px: circle + centre dot + 4 tick marks (N/E/S/W), pure red (168,12,30), no rotation                                                                                                                                                                                     |
| 446     | 0          | LAUNCH straight up (109,301)                                                                                                                                                                                                                                                                  |
| 447-455 | 33-300     | flight: y = 280, 261, 247, 225, 201, 177, 158, 131, 111 (avg 21 px/frame, straight, no scale, no spin)                                                                                                                                                                                        |
| 456     | 333        | ARRIVES on Tmomma (109,86): reticle now sits on the avatar face                                                                                                                                                                                                                               |
| 456-494 | 333-1600   | LOCK-ON phase (39 frames = 1.3 s): reticle stays ~14 px on the avatar but WANDERS: centre x drifts 108 -> 104 (f459-467), then -> 113 (f473-474), back to 109 (f480+), +-2 px in y: a "hunting" jitter of about +-5 px, roughly one slow left-right sweep per 25 frames. Colour constant red. |
| 495-497 | 1633-1700  | LOCK: reticle scales UP ~2x (bbox 84-137 = 53 px wide at f497)                                                                                                                                                                                                                                |
| 498-500 | 1733-1800  | reticle keeps growing to ~3.5x and FADES out (alpha -> 0). Gone at f501.                                                                                                                                                                                                                      |
| 501-513 | 1833-2233  | target clean: 13-frame pause with nothing visible (audio: missile whistle already started at f509)                                                                                                                                                                                            |
| 514     | 2267       | MISSILE appears at the very top edge, x~117, y~5, tiny (~4 px), nose down, small flame above it                                                                                                                                                                                               |
| 515-522 | 2300-2533  | missile dives straight DOWN (x 116-119 constant), y = 19, 26, 31, 39, 46, 53, 63, 69 (~7 px/frame) and GROWS with perspective from ~4 px to ~14 px long, ~22 px incl. the yellow-orange exhaust flame that trails UP from the tail. Red body, white stripe, dark nose.                        |
| 523-524 | 2567-2600  | HIT: missile nose at avatar centre (114,79); avatar region glows dull red (f523) - a red translucent circle ~45 px behind the missile, missile still drawn on top                                                                                                                             |
| 525     | 2633       | small yellow flame (~20 px) at the base of the avatar; missile gone                                                                                                                                                                                                                           |
| 526-527 | 2667-2700  | flame grows: 25 px then 35 px, pure yellow (247,243,74), cartoon "tongues" shape                                                                                                                                                                                                              |
| 528-531 | 2733-2833  | FULL FIREBALL: 53 px wide x 75 px tall (bbox (80,36)-(133,111)), i.e. 1.3x avatar width and extends 50 px ABOVE the avatar. Solid yellow with wavy spiky top; avatar and its "Fold" tag completely covered                                                                                    |
| 532     | 2867       | fireball turns orange, dark core appears                                                                                                                                                                                                                                                      |
| 533-536 | 2900-3000  | orange-red fireball with dark ember blotches, shrinking a little (1665 -> 1234 changed px)                                                                                                                                                                                                    |
| 537-556 | 3033-3667  | SMOKE: brown/khaki (110,85,60) mushroom cloud, ~48 px wide x 65 px tall, cap above the avatar, stem over it; slowly swells (750 -> 1050 changed px over 20 frames) and drifts ~4 px left then back; avatar fully hidden for these 20 frames (0.67 s)                                          |
| 557     | 3700       | smoke pops out in ONE frame (alpha ~40% at f557)                                                                                                                                                                                                                                              |
| 558     | 3733       | seat CLEAN, avatar back, no residue at all                                                                                                                                                                                                                                                    |

Sizes: reticle 14 px (35% of avatar) during flight/lock, ~50 px at lock
flash; missile 4 -> 14 px body; fireball 53x75 px; smoke 48x65 px.

Text / labels / counters: none. Free emojis 86 -> 85 (dialog at f569).

Game events that overlap this window (NOT part of the throwable):
drudiamond calls at f503 (pot 42.3K -> 77.1K), chips slide to Bjorno
f536-f551, new hand is dealt f560-f569 - so the audio f536+ may contain the
pot-award chip sound mixed into the explosion tail.

Audio (r2.npy / v2aud.py):

- Lock-on BEEPS: 4 identical short bright beeps (centroid ~5.9 kHz, ~5
  frames each, rms peak 0.063-0.066 = rel 14%) at f463, f479, f495 -
  spaced exactly 16 frames (533 ms) - then a doubled pair at f497 (0.061)
  and f502 (0.066) that coincides with the reticle scale-up + fade (the
  "locked" confirmation). The first beep comes 7 frames after the reticle
  lands (f456).
- MISSILE WHISTLE: continuous from f509 to f533 (25 frames = 0.83 s), rms
  0.13-0.17 (rel 30-38%), centroid falling 3.5 kHz -> 2.6 kHz (a
  descending whistle/roar). Starts 5 frames BEFORE the missile is visible.
- EXPLOSION: f534-f562, rms 0.15-0.26, peak 0.258 at f541 (rel 57%),
  centroid 2.4 kHz -> 1.0 kHz (deep boom + rumble), first big transient at
  f535 (10 frames after the first flame f525, 3 frames after the full
  fireball). Rumble decays to zero by f566.
- No sound for the reticle throw itself (f437-f462 silent).

Best reference frames: reticle hold f443; reticle flight f450; reticle on
target f460, f473 (wander), f496 (scale-up), f498 (fade); missile f516,
f520, f522; hit glow f523; flame f525, f527; fireball f530; orange f533,
f535; smoke f540, f550; pop f557; clean f558. Crops:
`v2_t3_reticle_a.jpg` (f433-456), `v2_t3_reticle_b.jpg` (f456-511 step 3),
`v2_t3_missile.jpg` (f508-531), `v2_t3_explosion.jpg` (f526-549),
`v2_t3_smoke.jpg` (f549-572).

### Throw 4 - BANANA (picker row 4, col 1: peeled banana) - hero -> bmrboy (lower-left seat, eagle)

NOTE: an INCOMING throwable from another seat overlaps this window - see
"Incoming A - PARTY FACE" right after this section. Both are visible at once.

Beat table (launch frame f675 = 0 ms):

| frame   | ms        | what is on screen                                                                                                                                                                                                               |
| ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 661     | -467      | PROFILE sheet (bmrboy) gone; Free emojis left read 85                                                                                                                                                                           |
| 670     | -167      | banana pops in on the hero's head, small (n=18 px)                                                                                                                                                                              |
| 671-674 | -133..-33 | HOLD at full size (~22 px long, peeled banana, yellow (219,193,43), tilted up-right) sitting top-right of the hero avatar at (109,340). (The party-face emoji is already covering the hero avatar underneath - see Incoming A.) |
| 675     | 0         | LAUNCH toward the lower-left seat (99,330)                                                                                                                                                                                      |
| 676     | 33        | (90,320)                                                                                                                                                                                                                        |
| 677     | 67        | (79,308)                                                                                                                                                                                                                        |
| 678     | 100       | banana at the upper-right edge of the eagle avatar (~(45,262)): CONTACT. ~25 px/frame, straight line, no spin, no scale change                                                                                                  |
| 679     | 133       | IMPACT FLASH: yellow star-burst "spark" (white core, yellow rays, ~20 px) at the top of the eagle's head; banana still visible inside it                                                                                        |
| 680     | 167       | flash grows to ~28 px with 5-6 rays and a couple of small sparkle dots, then                                                                                                                                                    |
| 681     | 200       | flash gone. RESIDUE: the banana peel lies draped over the top of the avatar like a hat, ~24 px wide, 40% of the avatar covered, avatar face still visible. It half-covers the "Fold" tag.                                       |
| 682-759 | 233-2800  | residue STATIC, no fade, no motion (78+ frames = 2.6 s+)                                                                                                                                                                        |
| 760     | 2833      | next PROFILE sheet slides up (covers the seat). Seat is clean when the sheet closes at f851 (=> residue life 2.6 s .. 5.7 s).                                                                                                   |

Sizes: banana ~22 px long (55% of avatar); flash 20-28 px; peel residue 24 px.
No avatar shake / tint. No text, no chat line. Free emojis 85 -> 84 (dialog f761).

Audio: the window is polluted by the party-face sound (below). The banana's
own sound is most likely the transient block f676-f682: rms 0.19 at f676,
0.18, 0.15, 0.16, 0.15, 0.15, 0.17 (rel ~40%), centroid 1.4-1.8 kHz, i.e.
a "boing/splat" starting 2-3 frames before the visual flash (f679-680) and
lasting ~7 frames, decaying to 0.04 by f689.

Best reference frames: hold f672; launch f675; flight f676, f677; contact
f678; flash f679, f680; residue f690, f730. Crops: `v2_t4_a.jpg`
(f659-682 whole lower table), `v2_t4_banana_impact.jpg` (f674-697),
`v2_t4_banana_res.jpg` (f698-758 step 4).

### Incoming A - PARTY FACE emoji (animated) - Bjorno (upper-left) -> hero SunBum45

While the hero's picker was open for the banana, another seat sent an
animated "party face" emoji AT THE HERO. It is the only villain -> hero
throw in this video and shows what an incoming emoji looks like.

| frame   | ms (arrival f667 = 0) | what is on screen                                                                                                                                                                                     |
| ------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~658    | -300                  | (hidden under the PROFILE sheet) launched from Bjorno's avatar (40,160): extrapolating the straight track back at 23 px/frame lands exactly on that seat                                              |
| 661     | -200                  | first visible frame after the sheet closes: yellow round face ~24 px with a blue/rainbow cone party hat, at (67,221)                                                                                  |
| 662-666 | -167..-33             | flight down-right in a straight line: (75,243), (82,265), (91,289), (98,309), (105,331) = +7.5 px x, +22 px y per frame (23 px/frame), no spin, no scale                                              |
| 667     | 0                     | ARRIVES on the hero avatar (110,358) and REPLACES it: the emoji (~36 px, 90% of the avatar) sits exactly over the face; the "Fold" tag stays visible above it                                         |
| 667-681 | 0-467                 | neutral smile, hat on, static                                                                                                                                                                         |
| 682     | 500                   | a pink/purple PARTY HORN (blower) pops out to the left of the mouth, ~14 px                                                                                                                           |
| 686-702 | 633-1167              | mouth opens progressively to a wide open grin (f694-f702 biggest), small purple confetti triangles at right                                                                                           |
| 706-714 | 1300-1567             | eyes squeeze shut (laughing), mouth closes to a squint smile, horn stays                                                                                                                              |
| 714-758 | 1567-3033             | STREAMERS: red, green and purple curly ribbons fan out from the horn to the left (~20 px) and from the hat to the right; small dots of confetti; the whole pose holds and the streamers slowly extend |
| 760+    |                       | next PROFILE sheet covers the hero; still playing when hidden (>= 3.1 s on screen). The hero avatar is back to normal after the sheet closes (f852).                                                  |

Audio (probable party-face sound, overlapping the banana): crescendo
f669-f676 (0.013 -> 0.193, centroid rising 0.6 -> 2.1 kHz: a rising
party-horn "toot"), a second bright burst f691-f703 (rms 0.13-0.19,
centroid 4-5 kHz: whistle/blower), then a STEADY broadband bed f704-f777
(rms 0.080-0.091, centroid 3.3-3.6 kHz, 74 frames = 2.5 s: crowd
cheer/applause-like noise) fading out over f770-f778. The bed lines up with
the streamers phase.

Best reference frames: flight f662, f665; arrival f667; horn f682; open
mouth f698; squint f714; streamers f734, f758. Crop: `v2_t4_smiley_hero.jpg`
(f666-762 step 4), `v2_t4_smiley_src.jpg` (f655-662).

### Throw 5 - MONEY / CASH BUNDLE ("make it rain") (picker row 4, col 2: stack of dollar bills) - hero -> Tmomma (top seat)

Beat table (launch frame f865 = 0 ms):

| frame   | ms        | what is on screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 851-853 | -433      | Confirm, PROFILE sheet (Tmomma, "Free emojis left 84") closes                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 862     | -100      | bundle of bills pops in on the hero's head, small (grey-green rectangle stack, ~14x8 px)                                                                                                                                                                                                                                                                                                                                                                                                  |
| 863-864 | -67..-33  | HOLD at full size (~18x10 px, 3-4 bills fanned, greenish grey (172,172,156)) at (110,314). Only 3 frames of hold this time.                                                                                                                                                                                                                                                                                                                                                               |
| 865     | 0         | LAUNCH straight up (108,282)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 866-874 | 33-300    | flight y = 257, 241, 220, 200, 179, 158, 136, 116, 95 (~21 px/frame, straight, x 107-109, bundle keeps its slight tilt, no spin, no scale)                                                                                                                                                                                                                                                                                                                                                |
| 875     | 333       | bundle at the top of the rabbit's head (106,73)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 876     | 367       | bundle OVERSHOOTS above the head (~(95,40)), partly off the avatar                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 877-885 | 400-667   | bundle FALLS BACK onto the avatar with ease-out: y = 58, 69, 77, 84, 87, 92, 95, 93, 92 (11, 8, 6, 3, 5, 3 px/frame) and settles centred on the face (106,92), slightly larger (~22 px)                                                                                                                                                                                                                                                                                                   |
| 886-891 | 700-867   | BURST starts: single bills peel off the bundle and rise; changed-pixel count 108 -> 180                                                                                                                                                                                                                                                                                                                                                                                                   |
| 892-955 | 900-3000  | MONEY CLOUD: 10-15 individual "flying money" bills (each ~14x8 px with two small WHITE WINGS, the money-with-wings emoji) flutter in a fountain above and around the avatar. Extent ~70 px wide (bbox x 66-141) x 70 px tall (y 33-103): from the avatar's chin to 60 px above it. Bills rise from the avatar, flap, drift sideways and recycle; the cloud density is roughly constant (350-470 changed px per frame). The avatar and the "Fold" tag remain partly visible between bills. |
| 956-962 | 3033-3233 | cloud THINS: fewer bills spawn, the remaining ones rise off the top                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 963-970 | 3267-3500 | last 2-3 bills exit upward and fade; bbox shrinks to (67,33)-(114,61)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 971     | 3533      | seat CLEAN, no residue                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Trajectory summary: straight vertical throw at ~21 px/frame, 10 frames to
the avatar, then a small overshoot-and-settle bounce (1 frame up, 9 frames
down, decelerating) before the burst. The particle phase lasts 80 frames
(2.7 s). Total first pixel f862 -> clean f971 = 110 frames = 3.6 s.

Sizes: bundle 18x10 px in flight (45% of avatar), ~22 px settled; each
flying bill 14x8 px; cloud 70x70 px (1.75x avatar).

Text / counters: none. Free emojis 84 -> 83 (dialog at f981).

Audio: LOUDEST sustained effect in the video after throw 16.

- f875-f878: short "thump" (peak rms 0.129 at f877, rel 28%, centroid 2.2
  kHz) exactly when the bundle reaches the top of the head (f875-876).
- f881-f885: three faint high ticks (rms 0.02-0.06, centroid 5.5-7.4 kHz)
  during the settle.
- f886-f985: continuous CASH-REGISTER / COIN CASCADE: rms 0.2-0.44 (peak
  0.438 at f893 = rel 97%), rapid jingling transients every 2-4 frames,
  centroid bouncing 1.2-4 kHz. Starts exactly on the burst frame f886 and
  keeps going ~15 frames AFTER the last bill leaves (ends ~f985, 100 frames
  = 3.3 s). The next dialog opens at f981 while it is still playing.

Best reference frames: hold f864; flight f868, f872; top f875; overshoot
f876; settle f880, f885; burst f888; cloud f900, f920, f940; thinning f958;
fade f966; clean f971. Crops: `v2_t5_flight.jpg` (f862-885),
`v2_t5_rain_a.jpg` (f884-907), `v2_t5_rain_b.jpg` (f908-977 step 3).

### Throw 6 - RAT WITH A CARD ("cheating rat") (picker row 4, col 3: grey-blue rat head holding a card) - hero -> Briz3300 (upper-right seat)

This one is an ANIMATED CHARACTER overlay, not a projectile with a splat:
the rat head flies over, pops onto the target avatar, covers it completely
for 3.9 s while it pulls an Ace of spades out of its mouth, then vanishes.

Beat table (launch frame f1077 = 0 ms):

| frame     | ms        | what is on screen                                                                                                                                                                                            |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1063-1065 | -467      | Confirm, PROFILE sheet (Briz3300, "Free emojis left 83") closes                                                                                                                                              |
| 1071      | -200      | rat head pops in at the CENTRE of the hero avatar (108,345) - not on top of the head this time - small (n=21)                                                                                                |
| 1072-1076 | -167..-33 | scales up to full size in 5 frames: ~30 x 32 px (75% of avatar), grey-blue (137,140,180) rat head, big round ears, one eye wide one squinting, red tongue out                                                |
| 1077      | 0         | LAUNCH up-right (116,325)                                                                                                                                                                                    |
| 1078-1084 | 33-233    | flight in a straight line: (124,302), (132,280), (140,258), (148,235), (156,213), (164,190), (172,168): +8 px x, -22.5 px y per frame = 24 px/frame, constant; rat keeps full size and orientation (no spin) |
| 1085      | 267       | rat at (180,149) = Briz avatar centre, and SHRINKS (n 296 -> 95)                                                                                                                                             |
| 1086      | 300       | rat INVISIBLE for one frame (n = 0)                                                                                                                                                                          |
| 1087-1091 | 333-467   | POP-IN on the avatar: scales 0 -> 110% over 5 frames (n = 20, 77, 161, 272, 360), centred (179,147)                                                                                                          |
| 1092      | 500       | settles at 100% (n 216-260): rat head ~34 px wide x 34 tall, slightly larger than the avatar, fully covering the face; the "Fold" tag peeks out behind the left ear                                          |
| 1092-1100 | 500-767   | idle: both eyes open, tongue out                                                                                                                                                                             |
| 1102-1104 | 833-900   | head tilts, left eye winks/squints                                                                                                                                                                           |
| 1106-1116 | 967-1300  | a small face-down CARD (blue back, ~9x12 px) slides OUT of the rat's mouth toward the lower-right, tongue still visible                                                                                      |
| 1118-1142 | 1367-2167 | card held at the right of the mouth, face-down; rat chews (mouth open/close)                                                                                                                                 |
| 1146      | 2300      | card FLIPS (edge-on, one frame)                                                                                                                                                                              |
| 1150      | 2433      | card now shows the ACE OF SPADES (white card, black A + spade), ~10x13 px, held at the mouth                                                                                                                 |
| 1150-1202 | 2433-4167 | rat keeps the ace up; eyes wide, mouth opens in a laugh (f1166-1194), tongue wags, small head bobs (+-1 px)                                                                                                  |
| 1203-1205 | 4200-4267 | last frames, unchanged                                                                                                                                                                                       |
| 1206      | 4300      | rat and card GONE in one frame (no fade, no shrink); avatar and "Fold" tag back, no residue                                                                                                                  |

Sizes: rat 30x32 px in flight (75% avatar), 34x34 on target (105% avatar,
covers it entirely). Card 9x12 px.

Text / counters: none on the table. Free emojis 83 -> 82 (dialog at f1214).

Game events overlapping: drudiamond goes all-in at f1148 ("All in" pink
tag), pot 154.3K -> 385.6K -> 387.4K. Not part of the throwable.

Audio (r2.npy): a multi-part cartoon "rat" cue, all timed to the animation:

- f1093-f1098: faint high pop (0.058, centroid 6.3 kHz) = pop-in on target
- f1117-f1125: SQUEAK 1, rms peak 0.299 at f1119 (rel 66%), centroid
  falling 1.8 -> 0.8 kHz (a descending "squeak/gulp"), 9 frames
- f1128-f1139: SQUEAK 2, peak 0.168 at f1132 (rel 37%), same shape
- f1143-f1147: high ticks (0.076, 4.8 kHz) = card sliding out
- f1148-f1155: low "gulp" 0.10
- f1158-f1165: low "gulp" 0.15 (f1164)
- f1166-f1179: hissy laugh bed 0.07-0.12, centroid 5-6 kHz
- f1180-f1188: final squeak, peak 0.207 at f1180 (rel 46%), 2.7 kHz,
  decays to silence by f1203
- f1204-f1207: faint high pop (0.033) = disappearance
  Total sound span f1093-f1207 matches the on-target span f1087-f1205.

Best reference frames: spawn f1074; hold f1076; flight f1079, f1082; shrink
f1085; blank f1086; pop-in f1089; idle f1094; wink f1102; card out f1110;
card held f1130; flip f1146; ace f1150, f1170; laugh f1186; last f1205;
gone f1206. Crops: `v2_t6_flight.jpg` (f1070-1093), `v2_t6_mouse_a.jpg`
(f1086-1132 step 2), `v2_t6_mouse_b.jpg` (f1134-1226 step 4).

### Throw 7 - POOP (picker row 4, col 4: brown swirl) - hero -> Tmomma (top seat)

Beat table (launch frame f1322 = 0 ms):

| frame     | ms         | what is on screen                                                                                                                                                                                                           |
| --------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1309-1311 | -433       | Confirm, PROFILE sheet (Tmomma, "Free emojis left 82") closes                                                                                                                                                               |
| 1316-1318 | -200..-133 | poop pops in on the hero's head (top-right, (109,335)), scale-in                                                                                                                                                            |
| 1319-1321 | -100..-33  | HOLD: brown swirl ~16x18 px (40% of avatar), dark brown (118,70,50)                                                                                                                                                         |
| 1322      | 0          | LAUNCH straight up (109,301)                                                                                                                                                                                                |
| 1323-1331 | 33-300     | flight y = 286, 267, 237, 220, 203, 182, 155, 136, 109 (mean 20 px/frame; note two bigger steps of 30 and 27 px - the sprite is centred by bbox so this is jitter, not acceleration); x constant 108-110; no spin, no scale |
| 1332      | 333        | poop at the bottom of the rabbit avatar (107,88), still intact                                                                                                                                                              |
| 1333      | 367        | poop centred on the face (108,80), intact: CONTACT                                                                                                                                                                          |
| 1334      | 400        | SPLAT: the swirl is replaced by a brown-orange (129,91,54) splat sprite ~34 px across (85% of avatar) centred on the face, with radial splash spikes, PLUS one droplet (~5 px) shooting straight up ~30 px above the head   |
| 1335-1339 | 433-567    | splash grows: 3-4 droplets fly out up/up-right (to (125,45) by f1339), spikes lengthen; changed px 824 -> 906                                                                                                               |
| 1340-1347 | 600-867    | droplets decelerate and hang, the splat spikes settle; a few small dark drops sit at the upper-right                                                                                                                        |
| 1348-1409 | 900-2933   | RESIDUE STATIC: poop swirl (~22 px tall) sitting on the face with the brown splash ring around it; the avatar is ~70% covered; small drops frozen around it. No fade before the next sheet.                                 |
| 1410      | 2967       | next PROFILE sheet slides up and hides the seat; seat is CLEAN when it closes at f1483 (residue life 2.5 s .. 5.0 s)                                                                                                        |

Sizes: poop 16x18 px in flight; splat 34 px; droplets 4-6 px; residue 22
px swirl + ~36 px splash ring.

Text / counters: none. Free emojis 82 -> 81 (dialog f1412).

Overlapping game events: showdown "One Pair" banners f1331+, chips slide
to Bjorno f1385-f1409, "+194,074.41" float at Bjorno f1400-f1409. Not part
of the throwable.

Audio: ONE short wet splat at f1335 (rms 0.106, rel 23%, centroid 4.2 kHz),
1 frame after the visual splat (f1334), tail to f1349 (0.034, 0.017, ...).
The quiet high ticks f1384-f1399 (0.04-0.05, 5.5 kHz) are the chip-slide
sound of the pot award, not the throwable. No sound at spawn or launch.

Best reference frames: hold f1320; launch f1322; flight f1326, f1330;
contact f1333; splat f1334; splash f1337, f1341; settled f1350; residue
f1380. Crops: `v2_t7_flight.jpg` (f1318-1341), `v2_t7_impact.jpg`
(f1332-1355), `v2_t7_res.jpg` (f1356-1412 step 4).

### Throw 8 - TOMATO (picker row 4, col 5: red tomato) - hero -> Briz3300 (upper-right seat)

Beat table (launch frame f1498 = 0 ms):

| frame     | ms        | what is on screen                                                                                                                                                          |
| --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1483-1485 | -500      | Confirm, PROFILE sheet (Briz3300, "Free emojis left 81") closes; a new hand is being dealt (cards fly f1484-1490, seat drudiamond now EMPTY)                               |
| 1494      | -133      | tomato pops in on the hero's head (110,349), small (n=46)                                                                                                                  |
| 1495-1497 | -100..-33 | scale-in to full size: bright red (198,17,16) ball ~16 px with green stem, 40% of avatar                                                                                   |
| 1498      | 0         | LAUNCH up-right (118,327)                                                                                                                                                  |
| 1499-1505 | 33-233    | flight straight line: (126,304), (134,282), (142,259), (150,237), (158,214), (166,191), (174,169): +8 px x, -22.5 px y per frame = 24 px/frame constant; no spin, no scale |
| 1506      | 267       | tomato at the lower-left of the Briz avatar (183,149): SQUASH frame - the tomato is drawn flattened/semi-transparent over the face (n drops to 56)                         |
| 1507      | 300       | BURST: red splat ~30 px appears over the upper half of the face, 6-8 red chunks/droplets thrown outward                                                                    |
| 1508-1511 | 333-433   | splat expands to ~34 px (85% of avatar); droplets travel 6-10 px outward and stop                                                                                          |
| 1512-1520 | 467-733   | splat settles: bright red (194,33,36) splash with jagged edges, green stem/leaves at its centre-top, red drips reaching the chin; small droplets frozen around it          |
| 1521-1580 | 767-2733  | RESIDUE STATIC: avatar ~70% covered (eyes and cap hidden, mouth/chin visible), no fade, no motion                                                                          |
| 1581      | 2767      | next PROFILE sheet slides up; seat is CLEAN when it closes at f1654 (residue life 2.4 s .. 4.9 s)                                                                          |

Sizes: tomato 16 px in flight; splat 30 -> 34 px; droplets 2-4 px.
No avatar shake/tint. No text. Free emojis 81 -> 80 (dialog f1583).

Audio: ONE wet splat at f1508 (rms 0.106, rel 23%, centroid 3.9 kHz), 1
frame after the visual burst (f1507); tail f1509-f1522 (0.031, 0.015,
0.011, ...). The three high ticks f1480-f1491 (0.07-0.09, 5-5.7 kHz) are
the card-deal sounds of the new hand, not the throwable. Silent spawn and
launch.

Best reference frames: hold f1496; launch f1498; flight f1501, f1504;
squash f1506; burst f1507; expand f1509; settled f1515; residue f1540,
f1570. Crops: `v2_t8_flight.jpg` (f1494-1517), `v2_t8_impact.jpg`
(f1505-1528), `v2_t8_res.jpg` (f1530-1582 step 4).

### Throw 9 - SHARK ("card shark" with knife and fork) (picker row 5, col 1: blue cartoon shark) - hero -> Bjorno (upper-left seat)

Same ANIMATED CHARACTER mechanic as the rat (throw 6): spawns at the centre
of the hero avatar, flies as a full sprite, blinks out for one frame, pops
onto the target with an overshoot, animates on the face, then vanishes.

Beat table (launch frame f1667 = 0 ms):

| frame     | ms        | what is on screen                                                                                                                                                                                                  |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1654-1656 | -433      | Confirm, PROFILE sheet (Bjorno, "Free emojis left 80") closes                                                                                                                                                      |
| 1660      | -233      | shark pops in at the CENTRE of the hero avatar (104,339), small                                                                                                                                                    |
| 1661-1666 | -200..-33 | scales up to ~24 px: blue (90,138,188) cartoon shark head facing left, white belly, big toothy grin, a FORK in its left fin and a KNIFE in its right                                                               |
| 1667      | 0         | LAUNCH up-left (106,328)                                                                                                                                                                                           |
| 1668-1675 | 33-267    | flight straight line: (97,306), (89,284), (82,261), (73,238), (66,216), (58,193), (50,171), (42,148): -8 px x, -22.5 px y per frame = 24 px/frame constant; sprite full size, no spin                              |
| 1676      | 300       | shark INVISIBLE (n = 0) at the Bjorno seat                                                                                                                                                                         |
| 1677-1679 | 333-400   | POP-IN over the avatar: n = 3, 20, 49                                                                                                                                                                              |
| 1680      | 433       | OVERSHOOT: n = 93, bbox 35 x 40 px - roughly 1.5x the settled size                                                                                                                                                 |
| 1681-1682 | 467-500   | settles to ~20 x 28 px core (measured on the pure-blue pixels; whole sprite incl. white belly and grin ~36 px = 90% of avatar), centred (39,137); the dog avatar is fully covered, its hat brim just visible above |
| 1682-1782 | 500-3833  | CHEWING loop: mouth opens/closes every ~5-6 frames, the knife/fork fins bob 1-2 px, a brown morsel near the mouth; no other movement. Still playing when the next sheet opens at f1785 (>= 3.4 s on target).       |
| 1785      | 3933      | next PROFILE sheet slides up and hides the seat; the seat is CLEAN when it closes at f1874 (rat lasted 118 frames on target, so the shark most likely ends ~f1798 under the sheet)                                 |

Sizes: shark ~24 px in flight (60% of avatar), ~36 px on target (90%);
overshoot ~1.5x for one frame.

Text / counters: none. Free emojis 80 -> 79 (dialog f1788).

Audio: quiet, continuous, rhythmic "munching":

- f1680-f1694: near-silent bed (0.003-0.009)
- f1695-f1697: CHOMP, peak 0.091 at f1696 (rel 20%), centroid 2.7 kHz
- f1701-f1703: second chomp 0.038
- f1706-f1773: soft ticks (0.010-0.026, centroid ~3 kHz) at f1708, 1713,
  1719, 1724, 1730, 1735, 1740, 1745, 1750, 1755, 1761, 1767, 1771 -
  period 5-6 frames (170-200 ms), i.e. one tick per jaw cycle
- f1774-f1785: fades to silence. The whole cue spans the on-target phase.

Best reference frames: spawn f1662; hold f1666; flight f1669, f1672; blank
f1676; pop f1678; overshoot f1680; settled f1684; chewing f1700, f1740;
last visible f1782. Crops: `v2_t9_flight.jpg` (f1660-1683),
`v2_t9_shark_a.jpg` (f1678-1724 step 2), `v2_t9_shark_b.jpg` (f1726-1790
step 4).

### Throw 10 - DONKEY (picker row 5, col 2: grey donkey head) - hero -> Tmomma (top seat)

Third ANIMATED CHARACTER (same mechanic as rat and shark).

Beat table (launch frame f1887 = 0 ms):

| frame     | ms        | what is on screen                                                                                                                                        |
| --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1874-1876 | -433      | Confirm, PROFILE sheet (Tmomma, "Free emojis left 79") closes                                                                                            |
| 1880      | -233      | donkey head pops in at the centre of the hero avatar, small                                                                                              |
| 1881-1886 | -200..-33 | scales up to ~26 x 30 px: grey-blue donkey head, big teeth, upright ears, facing left                                                                    |
| 1887      | 0         | LAUNCH straight up (110,327)                                                                                                                             |
| 1888-1896 | 33-300    | flight y = 317, 293, 270, 247, 222, 197, 174, 150, 128 (23.5 px/frame constant), x = 107 constant; sprite ~26 x 30 px (65% of avatar), no spin, no scale |
| 1897      | 333       | donkey INVISIBLE for one frame at the target                                                                                                             |
| 1898-1902 | 367-500   | POP-IN over the rabbit: scale 0 -> full in 5 frames                                                                                                      |
| 1904      | 567       | OVERSHOOT (~1.3x), then settles f1906 at ~38 px (95% of avatar; rabbit fully covered, its ear tips show above)                                           |
| 1906-1932 | 633-1500  | idle: slow mouth open/close, ear wiggle (1-2 px)                                                                                                         |
| 1933-1946 | 1533-1967 | mouth opens wide (inhale "hee")                                                                                                                          |
| 1947-1980 | 2000-3100 | BRAY: mouth wide open showing teeth, head bobs +-2 px, eyes wide                                                                                         |
| 1981-2017 | 3133-4333 | mouth relaxes, small chewing motions; static-ish                                                                                                         |
| 2018      | 4367      | donkey GONE in one frame (n 1023 -> 446: the remaining diff is the rabbit's new "Call" tag). On-target span f1898-f2017 = 120 frames = 4.0 s (rat: 118). |

Sizes: 26x30 px in flight, ~38 px on target, overshoot ~1.3x for 2 frames.
Text / counters: none. Free emojis 79 -> 78 (dialog f2037).
Overlapping game events: hero's action bar (Fold / Call 24.4K / Raise) lit
from f1953; chips slide at f1950-1965. Not part of the throwable.

Audio: silent pop-in; then a donkey BRAY that starts late:

- f1924-f1932: faint bed (0.004-0.010)
- f1933-f1946: rising "hee" 0.034 -> 0.051, centroid ~2.5 kHz
- f1947: "HAW" transient, peak 0.109 (rel 24%), centroid 4.8 kHz
- f1948-f1980: sustained bray 0.04-0.09 (rel 10-20%), centroid 2-3 kHz,
  slowly decaying
- f1981-f1995: tail 0.02, silent by f2000
- f2021-f2026: faint high ticks (0.012-0.017) at the disappearance (may be
  the "Call" UI sound)
  The bray is 65 frames (2.2 s) long and begins 35 frames after the donkey
  lands.

Best reference frames: spawn f1882; hold f1886; flight f1890, f1894; blank
f1897; pop f1900; overshoot f1904; idle f1912; inhale f1940; bray f1950,
f1966; relax f1990; last f2017; gone f2018. Crops: `v2_t10_flight.jpg`
(f1876-1899), `v2_t10_donkey_a.jpg` (f1894-1940 step 2),
`v2_t10_donkey_b.jpg` (f1942-2030 step 4).

### Throw 11 - CHICKEN (picker row 5, col 3: brown rooster head, red comb) - hero -> Briz3300 (upper-right seat)

Fourth ANIMATED CHARACTER (rat / shark / donkey mechanic).

Beat table (launch frame f2140 = 0 ms):

| frame     | ms        | what is on screen                                                                                                                                                                                                              |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2126-2128 | -467      | Confirm, PROFILE sheet (Briz3300, "Free emojis left 78") closes; a new player "leebaram" has taken the lower-right seat                                                                                                        |
| 2137      | -100      | chicken pops in at the centre of the hero avatar (120,338), small (n=65)                                                                                                                                                       |
| 2138-2139 | -67..-33  | scales up to ~26 x 30 px: brown/tan chicken head, red comb (3 lobes) and wattle, yellow beak, white googly eyes, facing left                                                                                                   |
| 2140      | 0         | LAUNCH up-right (126,317)                                                                                                                                                                                                      |
| 2141-2147 | 33-233    | flight straight line: (133,296), (140,278), (147,255), (154,237), (160,217), (168,198), (174,177): +7 px x, -20 px y per frame = 21 px/frame; no spin, no scale                                                                |
| 2148-2149 | 267-300   | chicken INVISIBLE for two frames at the target                                                                                                                                                                                 |
| 2150-2152 | 333-400   | POP-IN over the Briz avatar: n = 35, 86, 165                                                                                                                                                                                   |
| 2154      | 467       | slight overshoot, then settles ~36 px (90% of avatar, face fully covered, "Fold" tag half hidden behind the comb)                                                                                                              |
| 2156-2164 | 533-800   | idle, head level                                                                                                                                                                                                               |
| 2166-2176 | 867-1200  | PECK: head tilts down ~20 deg (beak points down-left), then back up                                                                                                                                                            |
| 2178-2208 | 1267-2267 | head up, small bobs (+-2 px), beak closed                                                                                                                                                                                      |
| 2210-2230 | 2333-3000 | CLUCK: beak opens wide (f2218-2226 widest), head jerks forward/back 2-3 px                                                                                                                                                     |
| 2234-2262 | 3133-4067 | beak half open, small bobs; still on screen when the next sheet opens at f2265 (>= 3.8 s on target). Seat is clean after that sheet closes (f2334). Expected end ~f2270 by analogy with rat/donkey (118-120 frames on target). |

Sizes: 26x30 px in flight (65% of avatar), ~36 px on target.
Text / counters: none. Free emojis 78 -> 77 (dialog f2265). Overlapping
game events: turn card (10) dealt at f2217, chips move at f2145-2160.

Audio:

- f2153-f2156: landing THUD, peak 0.127 at f2153 (rel 28%), centroid ~1
  kHz, 1 frame after the pop-in completes (f2152)
- f2164, f2172, f2179: three soft single clucks (0.027-0.036, centroid
  1.2-1.5 kHz), spaced 7-8 frames
- f2184-f2190: loud "BAWK" 0.116-0.119 (rel 26%) for 4 frames, tail to
  f2191 - coincides with the head-up phase, NOT with the peck (f2166-2176)
- f2195-f2249: continuous clucking bed 0.02-0.09 (rel 5-19%), centroid
  2-3.2 kHz, swelling to 0.087 at f2239-2242 (the wide-beak phase ends
  f2230, so the swell comes ~10 frames after it), silent by f2250
- nothing at spawn/launch

Best reference frames: spawn f2138; launch f2140; flight f2143, f2146;
blank f2148; pop f2151; settled f2158; peck f2170; idle f2196; cluck f2220;
late f2250. Crops: `v2_t11_flight.jpg` (f2128-2151), `v2_t11_chk_a.jpg`
(f2146-2192 step 2), `v2_t11_chk_b.jpg` (f2194-2266 step 4).

### Throw 12 - BOMB (picker row 5, col 4: black round bomb with fuse) - hero -> Bjorno (upper-left seat)

Beat table (launch frame f2349 = 0 ms):

| frame     | ms        | what is on screen                                                                                                                                                                                                        |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2334-2336 | -500      | Confirm, PROFILE sheet (Bjorno, "Free emojis left 77") closes                                                                                                                                                            |
| 2344      | -167      | bomb pops in on the hero's head (top-right, ~(112,335)), small                                                                                                                                                           |
| 2345-2348 | -133..-33 | scale-in and HOLD: black sphere ~14 px (35% of avatar) with a short fuse up-right and a tiny yellow spark at the fuse tip                                                                                                |
| 2349      | 0         | LAUNCH up-left (~(95,330))                                                                                                                                                                                               |
| 2350-2356 | 33-233    | flight straight line to Bjorno: (88,308), (80,290), (72,265), (65,240), (57,218), (50,195), (44,175): -7 px x, -22 px y per frame = 23 px/frame; no spin, no scale, spark visible throughout                             |
| 2357      | 267       | bomb LANDS on the upper half of the dog avatar (40,150) and STAYS there (it does not burst on contact)                                                                                                                   |
| 2357-2392 | 267-1433  | FUSE phase, 36 frames = 1.2 s: bomb static (~16 px, covering the dog's forehead/hat), the yellow 4-point spark at the fuse tip flickers - changes size/shape every frame (3 to 7 px) - the fuse itself shortens slightly |
| 2392      | 1433      | pre-flash: yellow cracks/glow appear inside the black sphere                                                                                                                                                             |
| 2393      | 1467      | EXPLOSION: jagged yellow-orange burst ~40 px centred on the avatar                                                                                                                                                       |
| 2394-2395 | 1500-1533 | burst at full size ~45 px (1.1x avatar): spiky yellow flower shape with orange core, avatar hidden                                                                                                                       |
| 2396      | 1567      | burst turns translucent yellow-khaki                                                                                                                                                                                     |
| 2397-2399 | 1600-1667 | SMOKE puff: khaki/beige translucent cloud ~45 px; avatar (now with a raised "surprised" look - it is just the normal avatar) visible through it                                                                          |
| 2400-2403 | 1700-1800 | smoke thins, drifts up-left ~6 px, fades                                                                                                                                                                                 |
| 2404      | 1833      | seat CLEAN, no residue                                                                                                                                                                                                   |

Sizes: bomb 14-16 px; spark 3-7 px; burst 40-45 px; smoke ~45 px.
Total first pixel f2344 -> clean f2404 = 60 frames = 2.0 s.
Text / counters: none. Free emojis 77 -> 76 (dialog f2431).
Overlapping game events: Bjorno bets (23,942) at f2357, wins the pot at
f2419 ("+30,316.25" float + chip slide f2402-2428).

Audio:

- f2339-f2344: the same bright click as f282 (throw 2). It follows the
  sheet close by 5 frames in both cases and also coincides with an
  opponent action tag appearing; treat it as a game/UI sound, NOT part of
  the bomb.
- f2362-f2364: fuse IGNITION fizz, peak 0.051 at f2364 (rel 11%),
  centroid 5.5 kHz, 5 frames after landing (f2357)
- f2375-f2378: faint sizzle (0.017)
- f2390-f2393: fuse fizz crescendo 0.016 -> 0.033 (centroid 6.5 kHz),
  ending on the pre-flash frame
- f2394: BOOM, rms 0.174 (rel 38%), centroid 2.4 kHz, 1 frame after the
  visual burst (f2393); decays 0.113, 0.055, 0.021, 0.010 -> silent by f2401
- f2402-f2417: high ticks 0.015-0.057 = pot-award chip sound, not the bomb.

Best reference frames: hold f2347; launch f2349; flight f2352, f2355;
landing f2357; fuse f2365, f2380; pre-flash f2392; burst f2393, f2394;
smoke f2398, f2401; clean f2404. Crops: `v2_t12_flight.jpg` (f2340-2363),
`v2_t12_bomb_a.jpg` (f2358-2404 step 2), `v2_t12_bomb_b.jpg` (f2384-2431).

### Throw 13 - ROSE (picker row 5, col 5: red rose) - hero -> Tmomma (top seat)

A "nice" throwable: rose lands, re-grows behind the ear, a butterfly and a
lipstick kiss follow. No splat, no damage.

Beat table (launch frame f2511 = 0 ms):

| frame     | ms        | what is on screen                                                                                                                          |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 2497-2499 | -467      | Confirm, PROFILE sheet (Tmomma, "Free emojis left 76") closes; the previous hand's board cards are sliding away f2498-2506                 |
| 2504      | -233      | rose pops in on the hero's head (top-right, (112,340)), small                                                                              |
| 2505-2510 | -200..-33 | scale-in + HOLD: red rose head ~10 px with a green stem, total ~16 px tall (40% of avatar), stem pointing down-left                        |
| 2511      | 0         | LAUNCH straight up ((110,320))                                                                                                             |
| 2512-2520 | 33-300    | flight y = 300, 277, 252, 228, 205, 182, 160, 136, 112 (approx 23 px/frame, straight, x constant 108-110); rose upright, no spin, no scale |
| 2521      | 333       | rose reaches the avatar centre-left (104,100): CONTACT, still whole                                                                        |
| 2522-2525 | 367-467   | rose INVISIBLE for 4 frames                                                                                                                |
| 2526-2527 | 500-533   | a small red bud appears at the UPPER-RIGHT of the rabbit's head (121,72), behind the right ear                                             |
| 2528-2531 | 567-667   | bud GROWS to a full rose ~16 px, tilted ~30 deg to the right, tucked behind the ear like a hair ornament                                   |
| 2532-2536 | 700-833   | rose static                                                                                                                                |
| 2537      | 867       | a tiny pink BUTTERFLY (~5 px, two wings) appears ~25 px above the rose                                                                     |
| 2537-2602 | 867-3033  | butterfly flutters: wings alternate open/closed every 2 frames, drifts in a slow loop of ~8 px radius above the head (y 45-60, x 118-135)  |
| 2555      | 1467      | a red LIPSTICK KISS mark (~8 px, two-lobed) appears on the rabbit's right cheek                                                            |
| 2556-2586 | 1500-2500 | kiss mark stays on the cheek, grows slightly (8 -> 11 px)                                                                                  |
| 2590-2602 | 2633-3033 | kiss mark drifts DOWN the face ~15 px (cheek -> chin/neck) at ~1 px/frame while the rose and butterfly stay                                |
| 2606      | 3167      | next PROFILE sheet slides up; rose, kiss and butterfly still on screen (>= 3.4 s). Seat is clean when that sheet closes (f2684).           |

Sizes: rose 16 px in flight and on the head; butterfly 5 px; kiss 8-11 px.
Text / counters: none. Free emojis 76 -> 75 (dialog f2609).

Audio: silent through spawn, flight and re-grow (f2500-f2533). Then ONE
soft, long "sparkle/harp" cue: f2534-f2581, rising to peak rms 0.106 at
f2539 (rel 23%), centroid 1.4-2.2 kHz, decaying smoothly over 47 frames
(1.6 s) to silence at f2581. It starts 3 frames before the butterfly
appears (f2537). The kiss (f2555) and the drift have no sound of their
own. f2595-f2600 faint high ticks (0.02-0.046, 6 kHz) are a UI/chip sound.

Best reference frames: hold f2507; launch f2511; flight f2514, f2518;
contact f2521; blank f2523; bud f2527; grown f2531; butterfly f2541,
f2559; kiss f2557, f2578; drift f2594, f2602. Crops: `v2_t13_flight.jpg`
(f2500-2523), `v2_t13_rose_a.jpg` (f2517-2563 step 2),
`v2_t13_rose_b.jpg` (f2566-2610 step 4).

### Throw 14 - FISH (picker row 6, col 1: green-silver fish) - hero -> Briz3300 (upper-right seat)

"Slap with a fish": the fish lands across the face, lies there, is cut by
two light-blade slashes, then slides off.

Beat table (launch frame f2699 = 0 ms):

| frame     | ms        | what is on screen                                                                                                                                                                                            |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2684-2686 | -500      | Confirm, PROFILE sheet (Briz3300, "Free emojis left 75") closes                                                                                                                                              |
| 2696-2698 | -100..-33 | fish pops in on the hero's head (110,333): silver-green fish ~20 x 10 px, head pointing up-right, 50% of avatar                                                                                              |
| 2699      | 0         | LAUNCH up-right (115,318)                                                                                                                                                                                    |
| 2700-2707 | 33-267    | flight straight line: (123,297), (130,277), (138,256), (145,235), (152,212), (159,191), (170,173), (178,153): +7.5 px x, -21 px y per frame = 22 px/frame; fish keeps its head-first tilt, no spin, no scale |
| 2708      | 300       | IMPACT FLASH: yellow star-burst (white core, 6 rays, ~28 px) at the avatar centre-left, fish drawn on top; same flash sprite as the banana (throw 4)                                                         |
| 2709      | 333       | flash gone; fish lies DIAGONALLY across the upper half of the face (~26 px long, head upper-left, tail lower-right), covering eyes and cap brim; mouth visible below                                         |
| 2710-2749 | 367-1667  | fish rests, subtle 1 px wiggle only (the audio ticks every 4 frames suggest a tail flap that is below this resolution)                                                                                       |
| 2750-2753 | 1700-1800 | SLASH 1: a thin yellow-white light blade (~4 px wide, 35 px tall, slightly tilted) sweeps down across the fish from top-left                                                                                 |
| 2754-2757 | 1833-1933 | blade streak exits top-right (small spark at (185,105))                                                                                                                                                      |
| 2758-2761 | 1967-2067 | SLASH 2: second blade sweeps down across the fish from the top                                                                                                                                               |
| 2764-2775 | 2167-2533 | fish now shows a RED GASH (a red vertical streak across its middle) and the face beneath shows a red streak; fish starts to slip                                                                             |
| 2776-2792 | 2567-3100 | fish SLIDES DOWN the face (~1.5 px/frame), rotating slightly, passing the mouth and chin (f2786-2790 at the bottom edge of the avatar), fading in the last 3 frames                                          |
| 2794      | 3167      | fish gone; a faint reddish mark on the face fades out by ~f2802                                                                                                                                              |
| 2803      | 3467      | seat CLEAN (avatar highlighted for its turn at f2806, "Call" at f2814 - game events)                                                                                                                         |

Sizes: fish 20x10 px in flight, 26 px on target; flash 28 px; blade 4x35
px. Total first pixel f2696 -> clean f2794 = 98 frames = 3.3 s.
Text / counters: none. Free emojis 75 -> 74 (dialog f2867).

Audio:

- f2696-f2719: silent (no spawn / flight / impact sound - the flash at
  f2708 is SILENT, unlike the banana)
- f2720-f2749: soft ticks 0.02-0.044 (centroid ~3 kHz) at f2720, 2724,
  2728, 2733, 2736, 2741, 2745, 2749 - a 4-frame (133 ms) period, "fish
  flopping" while it lies on the face
- f2752-f2760: SLASH WHOOSH 1: rises 0.028 -> peak 0.164 at f2756 (rel
  36%), centroid 1.6-3.8 kHz, decays to 0.028 at f2760 - lines up with
  blade 1 (f2750-2757)
- f2762-f2771: SLASH WHOOSH 2: 0.058 -> 0.082 (rel 18%) -> 0.021, lines up
  with blade 2 (f2758-2761) plus the gash appearing
- f2772 on: silent. (f2805-f2818 ticks are the "Call" / chip sounds.)

Best reference frames: hold f2698; launch f2699; flight f2702, f2705;
flash f2708; resting f2720; slash 1 f2752; spark f2754; slash 2 f2758;
gash f2766; slide f2780, f2788; gone f2794. Crops: `v2_t14_flight.jpg`
(f2696-2719), `v2_t14_a.jpg` (f2708-2754 step 2), `v2_t14_b.jpg`
(f2756-2802 step 2), `v2_t14_c.jpg` (f2786-2832 step 2).

### Throw 15 - EMOTICON "laughing face with raised hand" (Emoticons section, row 1, col 3) - hero -> Bjorno (upper-left seat)

The dialog before this throw (f2866-f2994, Bjorno's profile) scrolls the
whole picker - Recently used, Character Emojis rows 1-6, VIP Emojis, and
the Emoticons grid - and picks an emoticon. Emoticons use the SAME
animated-character mechanic as the rat/shark/donkey/chicken (fly as a
sprite, blink, pop onto the target, animate, vanish) and ALSO consume one
free emoji (74 -> 73).

Beat table (launch frame f3011 = 0 ms):

| frame     | ms        | what is on screen                                                                                                                                                                                                                                            |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2994-2996 | -567      | Confirm, PROFILE sheet closes ("Free emojis left 74")                                                                                                                                                                                                        |
| 3005      | -200      | emoticon pops in at the centre of the hero avatar, small                                                                                                                                                                                                     |
| 3006-3010 | -167..-33 | scales up to ~30 px: yellow round face, squinting eyes, wide grin with tongue, RIGHT HAND raised beside the face with index finger up (the picker tile: laughing face + hand)                                                                                |
| 3011      | 0         | LAUNCH up-left (91,332)                                                                                                                                                                                                                                      |
| 3012-3019 | 33-267    | flight straight line: (85,315), (78,297), (73,280), (67,262), (61,245), (55,228), (49,211), (43,193): -6 px x, -17.5 px y per frame = 18.5 px/frame (a little slower than the animals' 23-24); no spin, no scale                                             |
| 3020      | 300       | emoticon at the Bjorno seat, shrunk (n 394 -> 216)                                                                                                                                                                                                           |
| 3021-3023 | 333-433   | POP-IN over the avatar (small -> big), face without the hand                                                                                                                                                                                                 |
| 3024      | 467       | settled: ~36 px (90% of avatar, face fully covered, "Raise" tag half hidden). Expression: eyes squeezed shut in a smug grin, rosy cheeks, mouth closed                                                                                                       |
| 3024-3034 | 467-800   | smug squint, tiny bobbing                                                                                                                                                                                                                                    |
| 3036-3053 | 867-1433  | LAUGH: mouth opens wide showing tongue, eyes stay squeezed, head rocks 1-2 px; still laughing when the next sheet covers it at f3054 (>= 1.1 s visible; the audio says it laughs to ~f3145, i.e. ~4 s on target). Seat clean when that sheet closes (f3142). |

Sizes: ~30 px in flight, ~36 px on target.
Text / counters: none. Free emojis 74 -> 73 (dialog at f3090).

Audio: CORRECTED 2026-09-06 by transcription + pitch tracking. The raised hand is an "L" on the
forehead and the cue is a RECORDED MALE VOICE: one sustained "Ooooooh!" (101.0-102.2 s, F0 ~232 Hz,
1.2 s) followed by "LOSER, LOSER, LOSER" (102.3-104.8 s; three words of ~0.8 s at F0 120-150 Hz).
The three "swells" measured below are the three words. RMS shape, kept for timing:

- f3026-f3028: onset 0.023 -> 0.107 (centroid 0.75-0.9 kHz, low male
  chuckle), 6 frames after the pop-in
- f3029-f3083: swell 1: rises steadily to 0.177 at f3041 (rel 39%), holds
  0.13-0.17 for 40 frames (centroid 1.0-1.6 kHz), peak 0.210 at f3076
  (rel 46%), drops at f3082-3084
- f3084-f3094: quieter "heh-heh" 0.04-0.06 (centroid ~0.5 kHz)
- f3097-f3120: swell 2: 0.045 -> 0.086 (f3105) -> 0.030, centroid 0.4-0.8 kHz
- f3124-f3145: swell 3: 0.050 -> 0.068 -> 0.017, then silent at f3146
  Total 120 frames = 4.0 s of laughter. The laugh starts on the smug-squint
  frames, not on the open-mouth frames.

Best reference frames: spawn f3007; hold f3010; flight f3014, f3017;
shrink f3020; pop f3022; smug f3028; laugh f3040, f3050. Crops:
`v2_t15_flight.jpg` (f2995-3018), `v2_t15_a.jpg` (f3008-3054 step 2),
picker crop `v2_pick_2992.jpg`.

### Throw 16 - EMOTICON "loudly crying face" (Emoticons section; picked from the scrolled grid at f3138-3142) - hero -> Briz3300 (upper-right seat)

Beat table (launch frame f3158 = 0 ms):

| frame     | ms        | what is on screen                                                                                                                                                                                                                                                                                                       |
| --------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3142-3144 | -533      | Confirm, PROFILE sheet (Briz3300, "Free emojis left 73") closes                                                                                                                                                                                                                                                         |
| 3155-3156 | -100..-67 | emoticon pops in at the centre of the hero avatar (110,357), tiny                                                                                                                                                                                                                                                       |
| 3157      | -33       | ~17 px: yellow round face, closed drooping eyes, small round mouth, rosy cheeks (a "sad, about to cry" face)                                                                                                                                                                                                            |
| 3158      | 0         | LAUNCH up-right (114,343) - the sprite is still growing during the first flight frames                                                                                                                                                                                                                                  |
| 3159-3166 | 33-267    | flight straight line: (122,320), (130,298), (138,275), (146,252), (154,230), (162,208), (170,185), (177,163): +8 px x, -22.5 px y per frame = 24 px/frame; sprite ~18 px (45% of avatar); no spin                                                                                                                       |
| 3167-3168 | 300-333   | emoticon INVISIBLE (n = 7, 11) at the Briz seat                                                                                                                                                                                                                                                                         |
| 3169-3171 | 367-433   | POP-IN: n = 75, 211, 407 (overshoot ~1.3x at f3171)                                                                                                                                                                                                                                                                     |
| 3172      | 467       | settled ~36 px (90% of avatar; face covered, "Call" tag half hidden)                                                                                                                                                                                                                                                    |
| 3172-3192 | 467-1133  | SAD phase: eyes closed, brows drooping, small "o" mouth, blush; the mouth slowly opens 1 px                                                                                                                                                                                                                             |
| 3194      | 1200      | CRY starts in one frame: mouth opens wide (dark red interior, ~10 px), two CYAN TEAR STREAMS (~5 px wide) shoot from both eyes straight down past the chin, a cyan puddle appears at the bottom of the avatar                                                                                                           |
| 3196-3246 | 1267-2933 | crying loop: tear streams ripple (the stream edges wobble every 2 frames), the puddle spreads to ~30 px wide, the mouth stays open, head shakes 1 px; still crying when the next sheet covers it at f3247 (>= 2.5 s on target; the audio continues to f3292, so ~4 s total). Seat clean when that sheet closes (f3340). |

Sizes: 18 px in flight, ~36 px on target; tear streams 5 x 25 px; puddle
up to 30 px wide.
Text / counters: none. Free emojis 73 -> 72 (dialog f3249).

Audio: the LOUDEST cue in the video. Pitch tracking (2026-09-06): the wail and the two bursts are
a recorded high cartoon CRY, sustained F0 340-350 Hz at periodicity ~0.9 (a voice, not a synth); no
words.

- f3167-f3170: faint pop 0.015-0.019 at pop-in
- f3191-f3198: sniffle/inhale rising 0.005 -> 0.037, centroid 3.5-4 kHz
- f3199-f3200: first SOB 0.164 (rel 36%), centroid 1.2 kHz, 5 frames
  AFTER the tears appear (f3194)
- f3207-f3226: WAIL: 0.014 -> 0.094 -> 0.17 -> peak 0.309 at f3217-3219
  (rel 68%), centroid 1.4-1.6 kHz, decays to 0.08 by f3227
- f3228-f3255: sobbing bed 0.02-0.08
- f3256-f3258: BURST 1, rms 0.453 at f3257 = the maximum of the whole
  recording (rel 100%), centroid 1.0 kHz
- f3262-f3266: BURST 2, 0.316 / 0.334, centroid 1.0-1.8 kHz
- f3267-f3292: tail 0.05 -> 0.01, silent by f3293
  Both loud bursts happen while the next PROFILE sheet is already open.

Best reference frames: spawn f3157; flight f3161, f3165; blank f3167; pop
f3170; sad f3180, f3190; cry start f3194; crying f3210, f3230, f3246.
Crops: `v2_t16_flight.jpg` (f3150-3173), `v2_t16_a.jpg` (f3164-3210 step
2), `v2_t16_b.jpg` (f3212-3250 step 2).

### Throw 17 - EMOTICON "heart eyes" (Emoticons section, row 2, col 3 in the f3335 grid: red heart-eyes face) - hero -> Tmomma (top seat)

Beat table (launch frame f3353 = 0 ms):

| frame     | ms        | what is on screen                                                                                                                                                                                     |
| --------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3340-3342 | -433      | Confirm, PROFILE sheet (Tmomma, "Free emojis left 72") closes                                                                                                                                         |
| 3350-3352 | -100..-33 | emoticon pops in at the centre of the hero avatar (110,345): yellow round face, wide surprised eyes, small mouth; scales to ~24 px                                                                    |
| 3353      | 0         | LAUNCH straight up (110,335)                                                                                                                                                                          |
| 3354-3363 | 33-333    | flight y = 311, 286, 264, 240, 218, 194, 170, 146, 122, 99 (23.5 px/frame constant), x = 110 constant; sprite ~24 px (60% of avatar); no spin                                                         |
| 3364      | 367       | shrinks at the target (n 229 -> 92)                                                                                                                                                                   |
| 3365      | 400       | INVISIBLE for one frame                                                                                                                                                                               |
| 3366-3367 | 433-467   | POP-IN small -> medium, centred slightly ABOVE the avatar                                                                                                                                             |
| 3368-3369 | 500-533   | OVERSHOOT: ~44 px (1.4x) and drawn high (centre y 68, i.e. 24 px above the avatar centre)                                                                                                             |
| 3370-3372 | 567-633   | shrinks and drops back to ~36 px centred on the avatar (y 85)                                                                                                                                         |
| 3372-3380 | 633-900   | SURPRISED phase: big round white eyes with black pupils, tiny ":3" mouth, rosy cheeks                                                                                                                 |
| 3382      | 967       | eyes turn into small PINK HEARTS                                                                                                                                                                      |
| 3384-3396 | 1033-1433 | hearts GROW to ~12 px each and pulse (bigger every ~4 frames), mouth stays ":3"                                                                                                                       |
| 3398      | 1500      | a dark-red DRIP (nosebleed) appears from between the eyes running straight down over the mouth to the chin (~3 px wide, 14 px long)                                                                   |
| 3400-3438 | 1567-2833 | heart eyes keep pulsing, drip stays; still on screen when the next sheet opens at f3439-3441 (>= 2.4 s on target; expected ~4 s like the other emoticons). Seat clean when that sheet closes (f3662). |

Sizes: 24 px in flight, ~36 px settled, 44 px overshoot; hearts 12 px;
drip 3x14 px.
Text / counters: none. Free emojis 72 -> 71 (dialog f3443).
Overlapping game events: pot awarded to Bjorno, chips slide f3410-f3428.

Audio:

- f3350-f3368: silent (spawn, flight, pop)
- f3369-f3404: SPARKLE / twinkle shimmer: starts at the overshoot frame,
  0.042 rising to 0.087 at f3379 (rel 19%), centroid 5-6.3 kHz (very
  bright), decaying smoothly over 35 frames to silence at f3404. The peak
  is 3 frames before the eyes turn to hearts (f3382).
- f3405-f3424: lower cue 0.05-0.10 (peak 0.103 at f3416), centroid
  1.5-4 kHz - starts 7 frames after the nosebleed drip (f3398); it may be
  the emoticon's second cue or the chip slide of the pot award (which
  starts f3410); the chip sound elsewhere in the video is quieter and
  brighter (5.5 kHz), so this is most likely the emoticon.
- f3425-f3438: tail 0.01-0.03.

Best reference frames: spawn f3352; flight f3356, f3360; blank f3365;
overshoot f3368; settled f3374; surprised f3378; hearts start f3382;
hearts big f3392; drip f3400, f3420. Crops: `v2_t17_a.jpg` (f3366-3412
step 2), `v2_t17_b.jpg` (f3414-3444 step 2).

### Throw 18 - EMOTICON "angry face that catches fire" (Emoticons section, row 3-4 area of the f3660 grid: orange angry face) - hero -> Bjorno (upper-left seat)

Last throw of the video. Same emoticon mechanic. The video ends with the
iOS notification shade being pulled down at f3840+ (no more throws).

Beat table (launch frame f3674 = 0 ms):

| frame     | ms        | what is on screen                                                                                                                                                                                                                            |
| --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3662-3664 | -400      | Confirm, PROFILE sheet (Bjorno, "Free emojis left 71") closes                                                                                                                                                                                |
| 3671-3673 | -100..-33 | emoticon pops in at the centre of the hero avatar: orange-yellow round face, angled white eyes, frown (angry)                                                                                                                                |
| 3674      | 0         | LAUNCH up-left (90,296) - already ~24 px                                                                                                                                                                                                     |
| 3675-3683 | 33-300    | flight straight line: (89,294), (85,283), (80,267), (74,248), (68,233), (62,217), (57,200), (50,183), (45,167): -5.5 px x, -16 px y per frame = 17 px/frame (slowest flight in the video; the first two frames are slower still, an ease-in) |
| 3684      | 333       | INVISIBLE for one frame at the Bjorno seat                                                                                                                                                                                                   |
| 3686      | 400       | POP-IN small at the avatar centre                                                                                                                                                                                                            |
| 3688      | 467       | OVERSHOOT ~44 px, drawn ~20 px above the avatar centre                                                                                                                                                                                       |
| 3690      | 533       | shrinks to ~28 px on the avatar                                                                                                                                                                                                              |
| 3692      | 600       | settled ~36 px (90% of avatar; "Bet" tag half hidden)                                                                                                                                                                                        |
| 3692-3722 | 600-1600  | ANGRY phase: angled white eyes with red rims, tight frown; colour ramps from orange (f3692) to deep red (f3722) over 30 frames; faint red heat shimmer around the head                                                                       |
| 3724-3730 | 1667-1867 | mouth opens into a shout (dark red oval ~8 px), eyes narrow further                                                                                                                                                                          |
| 3732      | 1933      | FLAMES: a yellow-orange fire plume (~14 px wide, 20 px tall) erupts from the top of the head, plus an orange "anger mark" star at the upper-right (~6 px); face stays red                                                                    |
| 3732-3800 | 1933-4200 | RAGE loop: flame flickers (shape changes every frame, tips rise 2-4 px), mouth opens/closes, head shakes 1 px; anger star pulses                                                                                                             |
| 3801-3803 | 4233-4300 | emoticon vanishes (no fade visible at step 4)                                                                                                                                                                                                |
| 3804      | 4333      | Bjorno avatar back, no residue. On-target span f3686-f3803 = 118 frames = 3.9 s (same as rat/donkey).                                                                                                                                        |

Sizes: 24 px in flight; 36 px on target; 44 px overshoot; flame 14x20 px.
Text / counters: none. Free emojis 71 -> (70 expected; no later dialog).

Audio (quiet cue, everything under rel 13%):

- f3674-f3697: silent (spawn, flight, pop-in, overshoot)
- f3698-f3735: low GROWL bed 0.009-0.026, dominant 150-800 Hz (centroid
  as low as 174 Hz at f3715) while the face reddens
- f3736-f3744: first ROAR/whoosh 0.033-0.047 (centroid 1.5-1.9 kHz),
  4 frames after the flames erupt (f3732)
- f3750-f3756: roar 2 (0.048 at f3752)
- f3765-f3769: low grunt 0.034 (centroid ~225 Hz)
- f3776-f3785: roar 3 (0.048)
- f3792-f3799: roar 4 (0.057 at f3797 = the loudest, rel 13%)
- f3800-f3814: tail 0.01-0.02, silent by f3815 (f3815-3819 = UI click of
  the recorder being stopped)
  The roars repeat every ~20 frames (0.7 s) for the whole flame phase.

Best reference frames: spawn f3672; flight f3677, f3681; blank f3684; pop
f3686; overshoot f3688; angry f3700; red f3720; shout f3728; flames f3732,
f3752, f3780; gone f3804. Crops: `v2_t18_a.jpg` (f3676-3722 step 2),
`v2_t18_b.jpg` (f3724-3808 step 4).

### After f3839

f3839-f3870: the iOS Notification Center is pulled down over the game
(motion spikes 3861-3870), f3870-f3912: lock-screen style overlay. No
throwables. End of recording.

## Appendix - automatic transcription (Whisper small.en, 2026-09-06)

Video 1: "[BLANK_AUDIO] (thunder) Good luck. Hmm? Hmm? Hmm? (crunching) (crunching) (popping)
(cheering) (dinging) (popping) (crunching) (gurgling) (cheering)". "Good luck" at 35.6 s is the
horseshoe; "Hmm? Hmm? Hmm?" at 56-68 s coincides with the dice hand (57-63 s) and is most likely
the model's reading of the dice rattle, not a voice (no voiced frames there on pitch tracking).

Video 2: "(crowd cheers) (paper crinkles) ... Oooooooh! Loser, loser, loser... _crying_ Oh loser
loser (camera shutter clicks)". "Oooooooh! Loser, loser, loser" at 98.8-104.8 s is throw 15 (the
L-hand emoticon); "_crying_" at 106-109 s is throw 16; the trailing "Oh loser loser" is the
model's guess at the crying face's second burst (F0 ~350 Hz, no words).
