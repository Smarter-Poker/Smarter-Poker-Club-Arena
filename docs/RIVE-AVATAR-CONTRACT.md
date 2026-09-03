# Rive Avatar Contract

What an artist has to build for a Club Arena avatar to become a rigged,
animated character, and what the code already does for them.

Written 2026-08-21. The integration is live and dormant: **no avatar is rigged
yet**, and until one is, this costs a player exactly one cached 404.

---

## Read this first: what a rig can and cannot do

The table artwork is **125x170 portrait crops**. Measured across the library:
most are head-and-shoulders, cropped at the chest. A couple (`free_detective`,
`free_fox`) have a posed hand near the face. **None have a reaching arm.**

So a rig CAN do:

- blink, eye darts, brow and mouth movement
- head turn, tilt, nod
- shoulder shrug, torso lean
- secondary motion on what is drawn — cape, mane, feathers, antenna, scarf

A rig CANNOT do:

- **reach out and push chips into the pot.** There is no arm in the frame. No
  runtime can rig a limb that was never drawn. That specific idea needs new
  three-quarter or full-body artwork, which is a re-draw, not a rigging job.

If arm-reach is the goal, commission the art first and this contract second.

---

## What you deliver

One `.riv` per avatar, named for the avatar's slug.

| Avatar artwork                    | Rig file          |
| --------------------------------- | ----------------- |
| `/avatars/table/vip_alien.webp`   | `vip_alien.riv`   |
| `/avatars/table/free_cowboy.webp` | `free_cowboy.riv` |

Put the files in the World Hub at `public/avatars/rive/`, and list them in
`public/avatars/rive/manifest.json`:

```json
{
  "version": 1,
  "rigs": {
    "vip_alien": "vip_alien.riv",
    "free_cowboy": "free_cowboy.riv"
  }
}
```

That manifest is the switch. An avatar absent from it stays on the static
artwork with the CSS choreography, which is the current behaviour for all of
them. **No code change is needed to light a rig up** — add the file, add the
line, done.

---

## The state machine

Exactly one state machine, named:

```
SeatState
```

If the machine is missing or differently named, the seat silently keeps the
static avatar. That is deliberate: a bad rig must never leave a hole where a
player's face was.

### Triggers — one-shot, fired the moment the player acts

| Input       | Fires when                      | The CSS equivalent it replaces |
| ----------- | ------------------------------- | ------------------------------ |
| `Push`      | bet, raise, call or all-in      | `spAvatarPush`                 |
| `Check`     | check                           | `spAvatarCheck`                |
| `Fold`      | fold                            | `spAvatarFold`                 |
| `Celebrate` | this seat won the pot           | `spAvatarCelebrate`            |
| `Lose`      | this seat lost a showdown       | `spAvatarLose`                 |
| `Alert`     | it just became this seat's turn | `spAvatarAlert`                |

`Celebrate` and `Lose` are a pair — implement both or neither. A table where
the winner reacts and the loser does not reads as oddly indifferent, which is
the gap `Lose` was added to close.

Every trigger is optional. A rig that implements only `Fold` and `Celebrate` is
valid; it simply will not react to the others.

### Booleans — held conditions, not events

| Input      | True while                     |
| ---------- | ------------------------------ |
| `IsActive` | it is this seat's turn to act  |
| `IsFolded` | this player is out of the hand |

There is no `IsTense` input. The static path has a time-pressure tremor
(`spAvatarTense`, under a third of the clock), but a rig should express time
pressure inside its own `IsActive` state rather than take a second boolean —
one held condition per real condition. If a rig wants the clock, read `IsActive`
and build the escalation into that state's timeline.

Use these for the **resting pose**, not for the reaction. `Alert` is the moment
of sitting up; `IsActive` is staying leant in for the rest of the turn. `Fold`
is the flick toward the muck; `IsFolded` is the slump they hold until the next
hand.

### Idle

Whatever the machine does with no input is the idle. Keep it quiet — nine of
these are on screen at once and the table already has ambient breathing on the
static path. A blink every few seconds reads as alive; constant motion reads as
noise.

---

## Sizing and framing

- Artboard **125 x 170**, matching the source artwork, so the rig lines up with
  the static bust it replaces.
- The character's feet/base must sit on the **bottom edge**. The seat anchors
  bust art to the name box by its bottom edge, so a rig floating in the middle
  of its artboard will float on the felt too.
- Transparent background. The felt shows through.

---

## What the code does for you

- **Loads nothing until a rig exists.** The runtime is a dynamic `import()`, so
  it builds into its own chunk (185 KB, 53 KB gzip) that is fetched only after
  the manifest confirms this avatar is rigged. Verified: `index.html` does not
  reference it.
- **One manifest request per session**, not one probe per seat. Nine seats share
  a single cached promise.
- **Falls back on every failure** — no manifest, avatar not listed, chunk fails,
  `.riv` 404s or is corrupt, state machine absent, or the player asked the OS
  for reduced motion. In all of those the static `<img>` and the existing CSS
  choreography render exactly as they do today.
- **Uploaded photos are ignored.** Only library bust art
  (`/avatars/table/{vip|free}_slug`) is ever looked up; a player's own photo has
  nothing to rig.

## Note for whoever wires up hosting

`@rive-app/canvas` fetches its WASM at runtime rather than bundling it, so the
first rigged avatar pulls a WASM payload from the runtime's CDN. If that is
unacceptable, self-host it and point the runtime at the local copy before rigs
ship. It cannot happen while no avatar is rigged.

---

## Testing a rig before it ships

`tests/unit/riveAvatar.test.tsx` mocks the runtime and asserts the wiring: that
the runtime never loads without a rig, that the manifest is requested once, and
that each gesture fires its documented trigger. Those tests are how the
integration was verified without any art existing — they are also the fastest
way to confirm the contract has not drifted.
