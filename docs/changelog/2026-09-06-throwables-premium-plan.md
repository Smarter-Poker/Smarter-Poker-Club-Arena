# Throwables: the premium animation programme (plan + measured reference)

2026-09-06. Dan: "CURRENTLY THEY ARE JUST EMOJI'S THAT DON'T DO ANYTHING ...
CREATE A COMPREHENSIVE UPGRADE AND ENHANCEMENT BUILDING PLAN TO TURN EACH OF
OUR STATIC THROWABLES INTO TRUE, PREMIUM FULLY ANIMATED THROWABLES", and
"categorize ours as well ... audit, improve and enhance as well as add any and
all new ones as you see fit."

Docs only; no code changes. Three files under `docs/throwables/`:

- `THROWABLES-PREMIUM-ANIMATION-PLAN.md`: the verdict (a still image per
  item is the ceiling; the reference is a rigged multi-part cartoon that
  performs on the target's chair for ~4.5 s), the measured PokerBros grammar
  and inventory (47 tiles), the audit of our 48 (eight ranked defects,
  including that `fn_use_throwable` never checks the item so the VIP tab is a
  label), the target architecture (Lottie assets + a spec per item + a
  sample-based sound library + a catalogue/ownership entitlement model), build
  sheets for every one of 48 + 15 + 12 (+4 seasonal) items with beats and
  cues, a six-phase plan (~10 weeks with one animator), and seven decisions
  for Dan.
- `pokerbros-reference-video-1.md` and `-2.md`: 31 throws catalogued frame by
  frame at 30 fps from the two captures, with audio onsets and a Whisper +
  pitch-tracking pass. Two spoken lines exist in the reference ("Good luck" on
  the horseshoe; "Ooooh! Loser, loser, loser" on the L-hand emoticon); the
  rest is designed sound.

Nothing in the plan changes what players are owed today. The free-allowance
change it recommends (30/month for every member) is Dan's decision under
CLAUDE.md 10.9 and is listed as such.

## Addendum, same day: the rulings and the sound library

Dan: "YOU DECIDE ON ALL OF THESE, I TRUST YOUR JUDGEMENT, AND FIND A OPEN
SOURCE SFX LIBRARY WE CAN USE FOR SOUND EFFECTS AND VOICES."

Section 6 of the plan is now seven rulings, not seven questions: one 2D
cartoon set for every item (the 3D renders become the brief and the store
stills); 43 free / 18 VIP / 14 premium / 4 seasonal with premium at 40
diamonds, seasonal 15, two packs at 200 and 120; 30 free throws a month for
every member and 500 for VIP; parity on the signature gags' beats with our
own art, sounds and one twist each; no avatar flinch or table shake for
throwables; five captions survive (GOOD LUCK, STRIKE!, IT'S GOOD!, OOF, TILT).

Section 3.3.1 is the sound library, each source's licence checked on its own
page today: Kenney Casino Audio / Impact Sounds / Interface Sounds /
Voiceover Pack (CC0), Freesound filtered to CC0 through its API, Sonniss
GameAudioGDC bundles (royalty-free, commercial, no attribution) for the
cinematic layer; excluded: BBC RemArc (non-commercial), anything CC-BY-NC or
ND, and the PokerBros recordings. Voices: Chatterbox (MIT; Turbo/Nano with
native `[laugh]` / `[chuckle]` tags; Nano runs on CPU) cloning a ten-second
clip Dan records, generated once at build time and shipped as files; Kenney's
CC0 voice is the stand-in until the clip exists. A manifest + build script +
licence test make every shipped cue traceable to its source and licence.
