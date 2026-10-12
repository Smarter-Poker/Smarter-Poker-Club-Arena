# HANDOFF PROMPT: Club Arena tournament result card and the crown crest repaint (2026-10-05)

Paste this whole document as the first message of a new chat. Everything you
need is here. Do not ask the owner what was done. It is below, with the
command that proves each claim.

State verified 2026-10-05 between 22:40Z and 23:35Z unless a line says
otherwise.

---

## Part 0. Who you are and what you are picking up

You are an engineering agent on Smarter.Poker's Club Arena, a Vite + React 19

- TypeScript SPA with a server-authoritative poker engine (`server/`, on
  Hetzner) and Supabase as the database. The repo is `~/Documents/club-arena`
  on the owner's Mac Studio (GitHub: `Smarter-Poker/Smarter-Poker-Club-Arena`).
  Many other AI agents commit to the same repo in parallel, all day.

The owner is Dan. On 2026-10-05 he sent a screenshot of the tournament result
card (the popup a player sees after busting or winning a tournament) and said:

> THE TOURNAMENT RESULT CARD HAS NO "X" OFF ON IT TO CLOSE THIS OUT, AND IT
> LOOKS PRETTY GENERIC OVERALL.

Then:

> GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE AND MAKE SURE THEY
> ARE FULLY WIRED IN AND TESTED BEFORE CLAIMING SUCCESS. YOU DECIDE THE BUILD
> ORDER.

A previous agent (Claude) shipped two PRs, #6142 and #6184. Both are merged
and live. **One item was not done because that agent could not reach
api.openai.com: repainting the crown crest at the top of the card.** That
repaint is your main job. You are the right agent for it because the approved
recipe uses OpenAI's `gpt-image-1`.

What went wrong in the prior session, so you do not repeat it:

1. The card had been on the "every popup has an X" law's exemption list with
   a false reason ("carries its own painted close control"). The control was
   the word Close at the bottom of the card. An exemption with a written
   reason was believed for weeks. Lesson: read the code an exemption points
   at before you trust the exemption.
2. Running `prettier --write src/components/tournament/*.tsx` reformatted an
   unrelated file (`MysteryBountyPanel.tsx`) and it was pushed. It had to be
   cut out with a soft reset and a force-push of the feature branch. Lesson:
   format only the files you changed.
3. The first CI run of #6184 failed `Production Build`: the new code put the
   initial download at 321kB gzipped against a 320kB gate. It was fixed by
   lazy-loading the card. Lesson: anything mounted at the app root is in the
   chunk every player downloads first. Build and run the bundle scripts
   locally before you push.

## Part 1. STOP CONDITIONS. Read before any work.

Dan's standing rules that apply to this task, in his words:

> "THE 'SPADE' ICON IS PERFECT, HIGH DEFINITION DYNAMIC ICON WITH DEPTH AND
> THE 3D LOOK AND FEEL ... THE REST ARE ALL CHEAP LOOKING, FLAT AND BORING"
> (2026-09-13)

> "EVERY ICON NEEDS ITS OWN CUSTOM HOLDER LIKE THE SPADE HAS. ANYTIME YOU USE
> A CUSTOM ICON YOU MUST BUILD A NEW FRAME HOLDER AND COMPLETELY REDESIGN THE
> TOP FRAME (NEVER JUST COPY AND PASTE)." (2026-09-09)

> "the spade is your anchor, if it doesn't have the same quality, then you
> fail" (2026-09-09)

> "CHANGE THIS CARD TO SMARTER.POKER COLOR SCHEMA'S NO BROWNS OR YELLOWS."
> (2026-08-23, for this card)

> "I DO NOT WANT CRONS AND 'BACK PAY JOBS'! ... I WANT HARD CODED FIXES AT THE
> ROOT SOURCE" (2026-09-07; the owner's standard is "no watcher shall stand
> in place of a fix")

What you must NOT do:

- **Do not overwrite `public/assets/club-buttons/console/spade-console-v1/top-vip.png`
  or `source/crest-vip.png`.** Their bytes are sealed by
  `tests/the-media-optimizer-remembers-and-is-idempotent.law.test.ts`
  (`SEALED_PUBLIC_ASSET_BYTES`), because players whose open tab still holds
  the old `index.html` request those exact URLs. Ship the new crest under
  NEW file names (`crest-vip-v2.png`, `top-vip-v2.png`) and repoint the code.
- **Do not draw the crest in code** (SVG, canvas, CSS). A crest is painted,
  never drawn. The only drawn illustration allowed on this card is the medal.
- **Do not use warm colours** (gold, amber, brown, bronze) anywhere in
  `TournamentRankingCard.css`. `tests/unit/rankingCardPalette.test.ts` fails
  on any hue between 20 and 70 degrees with saturation over 0.25.
- **Do not use `background-clip: text`** for chrome type. Engraved silver is
  a solid colour plus a `text-shadow` bevel.
- **Do not commit in `~/Documents/club-arena` directly.** The pre-commit hook
  refuses the shared clone. Use an agent worktree (Part 2).
- **Do not `--no-verify`, force-push main, or bypass hooks.** Force-pushing
  your OWN feature branch with `--force-with-lease` is fine.
- **Do not read or print values from `.env*` files.** Do not use Dan's
  personal account for anything scripted.
- **Do not spend real chips to test** (a real tournament entry is a real
  buy-in). See Part 6, item M1.
- **Do not create schedulers, watchers or retry loops** to get a release out.
- **No em dashes (U+2014)** in any text a player reads. Every word a player
  reads is Title Case.
- **Do not reformat files you did not change.** Run prettier on your own
  paths only.

## Part 2. Environment bootstrap. Run these first.

```bash
cd ~/Documents/club-arena
git fetch origin main
git log --oneline -1 origin/main              # anything at or after cd0207f1 is fine

# Prove the prior work is on main (each must print nothing and exit 0):
for p in src/components/tournament/rankingShareImage.ts \
         src/components/tournament/rankingTrophy.ts \
         tests/components/TournamentRankingCardPolish.test.tsx \
         tests/components/TournamentRankingCardHasAnX.test.tsx \
         docs/changelog/2026-10-05-the-result-card-finished.md; do
  git cat-file -e origin/main:$p && echo "ok $p"; done

# Claim your own worktree and branch (sets the git identity the hooks require):
eval "$(bash scripts/agent-workspace.sh root feat/vip-crest-repaint)"
pwd    # you are now in your worktree; work ONLY here
```

Tool and shell quirks on this Mac:

- `gh` is at `/opt/homebrew/bin/gh`. It is not on a non-interactive PATH. Use
  `export PATH=/opt/homebrew/bin:$PATH`.
- The pre-commit hook runs lint-staged (eslint + prettier). If eslint crashes
  with `scopeManager.addGlobals is not a function`, a global eslint is
  shadowing the repo's. Fix it with `export PATH=$PWD/node_modules/.bin:$PATH`.
- The commit identity must be `Smarter-Poker
<254329056+Smarter-Poker@users.noreply.github.com>`.
  `scripts/agent-workspace.sh` sets it. If the identity guard refuses your
  commit, set exactly that with `git config`.
- macOS `sed` is BSD sed. Do multi-line edits with Python, not `sed`.
- The full vitest suite (`npx vitest run tests/`) takes 25 minutes or more.
  Run it in the background with output to a log file and poll the log. Run
  targeted suites in the foreground (Part 9).
- `OPENAI_API_KEY`: on 2026-10-05 no `.env`, `.env.local` or `server/.env`
  in the repo defined it. Use whatever OpenAI credential your own environment
  provides. Never write a key into the repo or a commit.

## Part 3. How the thing actually works

The trigger is a tournament ending for the player:

```
server engine: eliminatePlayer / finishTournament
  -> broadcast player_eliminated / tournament_winner
src/pages/TablePage.tsx (goToLobbyWithResult)
  -> publishSessionSummary(payload with .tournament)    src/services/pendingSessionSummary.ts
src/App.tsx mounts <TournamentRankingHost/> at the app root (outside <Routes>)
src/components/tournament/TournamentRankingHost.tsx
  -> React.lazy(() => import('./TournamentRankingCard'))   (lazy since #6184)
src/components/tournament/TournamentRankingCard.tsx
  -> <SpadeConsole crest="vip" onClose={onDismiss} ...>    src/components/console/SpadeConsole.tsx
       head art: .sc--crest-vip .sc__head -> top-vip.png   src/components/console/SpadeConsole.css:90
  -> on open: import('./rankingShareImage') pre-paints the share PNG
       (draws top-vip.png + mid.png + bottom-foot.png on a 1000x1420 canvas)
  -> Share: navigator.share(files) -> navigator.share(text) -> downloadBlob + clipboard
```

The console chassis (`SpadeConsole`) is Dan's approved master art, cut into
slices: `top.png` (1000x348 head with the crest), `mid.png` (rails, repeated),
`bottom-plates.png` / `bottom-foot.png`. Text is printed into zones measured
in master pixels. The crest variants are `top-<name>.png`. Each is produced by
`scripts/art/seat-console-crest.py` from a painted crest source
(`source/crest-<name>.png`). Outside the crest window, every variant is
pixel-identical to `top.png`.

`crest="vip"` (the crown) is used by six surfaces. Your repaint changes all
of them at once:

| Surface                 | File                                                  |
| ----------------------- | ----------------------------------------------------- |
| Tournament result card  | `src/components/tournament/TournamentRankingCard.tsx` |
| Tournament results page | `src/pages/tournament/TournamentResultsPage.tsx`      |
| Tournament lobby        | `src/pages/tournament/TournamentLobbyPage.tsx`        |
| VIP page (two consoles) | `src/pages/VIPPage.tsx`                               |
| VIP cards modal         | `src/components/vip/VIPCardsModal.tsx`                |
| Public landing page     | `src/pages/PokerArenaLandingPage.tsx`                 |

The share image also loads the crown head directly:
`src/components/tournament/rankingShareImage.ts`, const `ART` + `top-vip.png`.

Release route (client-only change, no engine involvement): your branch, then
a PR, then required checks, then a protected squash merge (an automation
queues it), then `publish-club-arena.yml`, then the Hetzner static origin.
`https://smarter.poker/hub/club-arena/*` is a World Hub rewrite to
`https://ca-static.smarter.poker`. A newer merge cancels an in-flight publish,
and the newest one wins. That is normal.

## Part 4. Complete state inventory (verified 2026-10-05 ~23:30Z)

| PR    | Merge commit on main | What                                                                                                                                                                                                                       |
| ----- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #6142 | `d7c4ef06a3`         | X in the card's head (`onClose`), exemption removed from the X law, first redesign (place band, medal rim, starburst, payout under the place)                                                                              |
| #6184 | `c5809b1086`         | Whole chip figures, "ID: 7" label, foot Close word retired, satellite head (pill names Seat/Ticket/Cash, "Seat Won", gold cup), long names cut with an ellipsis, reveal + payout count-up, picture share, card lazy-loaded |

Live (verified 2026-10-05 23:10Z): both
`https://smarter.poker/hub/club-arena/build-info.json` and
`https://ca-static.smarter.poker/build-info.json` report
`ca_sha fe6ecbc15d6d4a17961eaed7aed44b9188ce7dc5` (publisher run
37382748760, success). That commit contains both merges. The live entry
bundle does not contain the card. The lazy chunk
`TournamentRankingCard-*.js` contains "Third Place", "ID: ", "Image Saved"
and " Won". The live painter chunk `rankingShareImage-*.js` was imported on
smarter.poker and painted a 1000x1420 PNG (912,528 bytes) with the art
loaded.

| Measure (production Vite build, gzip) | Before #6184 work  | After |
| ------------------------------------- | ------------------ | ----- |
| Initial load, gate 320kB              | 321kB (card eager) | 312kB |
| `src` modules in entry chunk          | 232                | 223   |

Tests added: `tests/components/TournamentRankingCardHasAnX.test.tsx` (3) and
`tests/components/TournamentRankingCardPolish.test.tsx` (7). Updated:
`TournamentRankingCardMysteryBounty.test.tsx`, `tournamentRankingHost.test.tsx`
(the forced ".00" strings) and `tests/unit/everyPopupHasAnX.law.test.ts`
(exemption removed).

No migrations, no engine changes, no schedules.

Changelogs: `docs/changelog/2026-10-05-the-result-card-has-an-x.md` and
`docs/changelog/2026-10-05-the-result-card-finished.md`.

## Part 5. The task that blocks everything else: repaint the crown crest

**Done:** nothing on the crest. `top-vip.png` is the September version Dan
called "cheap looking, flat and boring". The repo skill describes it as "the
crown is a wireframe on a plate with a thick band".

**Not done:** paint, seat, wire, render, ship.

**The bar.** At 3x zoom, the spade crest in `top.png` has four things the
crown lacks. All four are required:

1. a bright polished-chrome catch on the emblem's upper edge;
2. a quilted dark body behind the emblem;
3. a blue LED glowing along the base of the well;
4. the rails mitred INTO the housing, so the frame flows into the crest. The
   seating script does this part.

The border must be thin and clean, like the approved diamond hexagon's. No
thick frame, rivets, knurling or brushed band.

### Step 1. Paint (OpenAI images edit)

Build the two reference images:

```bash
python3 - <<'EOF'
from PIL import Image
K='public/assets/club-buttons/console/spade-console-v1/'
top=Image.open(K+'top.png').convert('RGBA')
crop=top.crop((389,0,611,170))            # the spade crest; check by eye and adjust the box
sq=Image.new('RGBA',(1024,1024),(0,0,0,0))
crop=crop.resize((crop.width*4,crop.height*4),Image.LANCZOS)
sq.paste(crop,((1024-crop.width)//2,(1024-crop.height)//2))
sq.save('/tmp/ref-spade.png')
Image.open(K+'source/crest-diamond.png').convert('RGBA').save('/tmp/ref-diamond.png')
EOF
```

Call the API (`n=3`, so you can pick):

```bash
curl -sS https://api.openai.com/v1/images/edits \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F model=gpt-image-1 -F size=1024x1024 -F quality=high \
  -F background=transparent -F n=3 \
  -F "image[]=@/tmp/ref-spade.png" -F "image[]=@/tmp/ref-diamond.png" \
  -F prompt="$(cat <<'P'
Two reference images from a poker app's console frame, painted in a high-definition photoreal casino style. The first is the original crest: a pointed chrome shield with a bevelled chrome spade emblem on a black quilted face and a blue LED glowing along its base. The second is an approved new crest: a hexagonal bezel with a THIN, clean polished-chrome border, a dark gunmetal face, a bevelled chrome diamond emblem and a blue LED at the base. Create another crest in exactly the same materials, lighting, finish, palette, scale and BORDER WEIGHT as the second image: a wide keystone housing, holding a chrome crown emblem rendered exactly like the spade and the diamond (a bevelled polished-chrome outline with a bright polished catch along its upper edge, a dark quilted body, blue light bouncing off its lower edge), with a blue LED glowing along the floor of the well. The crown must be a solid bevelled chrome object, not a wireframe outline. The border must be thin and clean like the hexagon's: no thick frame, no rivets, no brushed band, no knurling, no gold, no yellow, no brown. One standalone object, centred, on a fully transparent background: no rails, no panel, no text.
P
)" > /tmp/crest-vip.json
python3 - <<'EOF'
import json,base64
d=json.load(open('/tmp/crest-vip.json'))
for i,x in enumerate(d['data']):
    open(f'/tmp/crest-vip-cand{i}.png','wb').write(base64.b64decode(x['b64_json']))
print(len(d['data']),'candidates')
EOF
```

If the response is an error, read it. A content or parameter error is not a
reason to retry in a loop. Fix the request and try once more.

### Step 2. Pick

Seat each candidate (Step 3) and render it at 393px on black next to the
spade head. Pick against the four criteria above. Reject any candidate with a
thick border, any warm tone, a flat or outline emblem, or anything left on
the transparent field (rails, panel, text). If none passes, change the prompt
and paint again. Do not ship a candidate that fails the bar. "Less bad than
before" is not the standard; the spade is.

### Step 3. Seat (new file names only)

```bash
cp /tmp/crest-vip-candN.png public/assets/club-buttons/console/spade-console-v1/source/crest-vip-v2.png
pip3 install numpy scipy pillow --quiet   # if missing
python3 scripts/art/seat-console-crest.py \
  public/assets/club-buttons/console/spade-console-v1/source/crest-vip-v2.png vip-v2 132 18 204
# writes public/assets/club-buttons/console/spade-console-v1/top-vip-v2.png
```

`132 18 204` (height, top, max width) are the arguments the September crown
used. If your crest's proportions differ, tune them, and compare the result
against `top.png` and `top-diamond.png` at 3x. The crest must sit in the same
place and at the same visual weight as the spade.

Then run `npm run art:matte` (`scripts/art/check-asset-matte.mjs`) and read
its output for the new files.

### Step 4. Wire

- `src/components/console/SpadeConsole.css` line ~90: in `.sc--crest-vip
.sc__head`, change `top-vip.png` to `top-vip-v2.png`.
- `src/components/tournament/rankingShareImage.ts`: change the `top-vip.png`
  load to `top-vip-v2.png`.
- `public/assets/club-buttons/console/spade-console-v1/source/README.md`: add
  `crest-vip-v2.png` to the sources list and its seating line. Say it
  supersedes `crest-vip.png`, and that the old file stays because its bytes
  are sealed.
- Leave `top-vip.png` and `crest-vip.png` in place, untouched.
- `grep -rn "top-vip" src tests` must show no remaining reference to the old
  file except the sealed-bytes table in the media law test.

### Step 5. Render before/after (the repo's console harness)

Read `.claude/skills/club-arena-console/SKILL.md` in full first (it is long;
sections 0, 1, 3.4, 3.6, 6 and 7 bind this task). The harness lives in
`.claude/skills/club-arena-console/harness/`. Copy `card-harness.html`,
`card-harness.tsx` and `shot.mjs` (as `.shot.mjs`) to the worktree root,
render, and delete them before committing. They must never be committed.

- Add surfaces to the switch in `card-harness.tsx`. For the result card:
  `const { default: Card } = await import('./src/components/tournament/TournamentRankingCard');`
  then render it with `result={{ name: 'NLH Heads-Up 1', finishPlace: 1, entrants: 2, prize: 1.9, bountyWinnings: 0, knockouts: 0, rebuys: 0, addOns: 0, isSpin: false }}`,
  `unitCents={1}` and `onDismiss={() => {}}`. Add the VIP cards modal the
  same way.
- **Fonts must be loaded or every fitted label measures wrong.** Use
  Roboto Condensed and Inter. If Google Fonts is unreachable, install
  `@fontsource/roboto-condensed` and `@fontsource/inter` into a temp folder,
  copy the latin 400-900 woff2 files into a dot-folder in the worktree, and
  import a small `@font-face` CSS file from the harness. Delete the folder
  afterwards.
- `run-shots.sh` assumes Linux ARM paths. On the Mac, start
  `npx vite --port 5199 --strictPort`, export dummy
  `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, and run `node .shot.mjs
"http://localhost:5199/hub/club-arena/card-harness.html?surface=<key>"
<outdir>` with Playwright's Chromium.
- The card has a reveal animation (about 1.7s). Screenshot at least 2.6s
  after load, or you will capture a half-built card.
- Shoot "before" on `origin/main` and "after" on your branch. Put them side
  by side with the spade (`crest="spade"`) for reference.

### Step 6. Decide, then ship

- If the after is clearly at the spade's bar, ship it (Steps 7 to 9) and show
  Dan the before/after sheet in your report.
- If you are not sure, show Dan the before/after sheet and the three
  candidates, and ask which one, or whether to repaint. Do not ship an
  uncertain crest onto six surfaces.

### Step 7. Gates, then push

```bash
export PATH=$PWD/node_modules/.bin:/opt/homebrew/bin:$PATH
npx tsc --noEmit -p tsconfig.app.json
npx vitest run tests/the-media-optimizer-remembers-and-is-idempotent.law.test.ts \
  tests/unit/rankingCardPalette.test.ts tests/painted-zones-never-overlap.law.test.ts \
  tests/unit/everyPopupHasAnX.law.test.ts tests/components/TournamentRankingCard*.test.tsx \
  tests/unit/tournamentRankingHost.test.tsx
grep -rln "top-vip\|crest-vip\|seat-console-crest" tests   # run every test file this lists too
VITE_SUPABASE_URL=https://dummy.supabase.co VITE_SUPABASE_ANON_KEY=dummy npx vite build
node scripts/ci/bundle-size.mjs              # must print OK and initial <= 320kB gz
node scripts/ci/entry-chunk-delta.mjs dist   # must say nothing new entered first paint
rm -rf dist
```

Write `docs/changelog/2026-10-XX-the-crown-crest-repaint.md` (your own file;
never append to `MIGRATION-CHANGELOG.md`). Commit only your paths, then run
`git push -u origin feat/vip-crest-repaint`. The pre-push hook runs the
tests covering your change, in about 30 to 90 seconds. Open the PR with
`gh api repos/Smarter-Poker/Smarter-Poker-Club-Arena/pulls -f base=main -f
head=feat/vip-crest-repaint -f title=... -F body=@file`.
(`gh pr create` uses GraphQL, which may be refused; the REST call works.)

### Step 8. Required checks and merge

Poll `gh api repos/Smarter-Poker/Smarter-Poker-Club-Arena/commits/<head-sha>/check-runs?per_page=100`.
An automation ("Queue this PR for protected squash merge") merges once the
required checks pass. Watch `gh api repos/Smarter-Poker/Smarter-Poker-Club-Arena/pulls/<n> --jq '.state,.merged,.merge_commit_sha'`.
See Part 8 for the runner-starvation trap.

### Step 9. Verify live

See Part 9. Then report to Dan: PR, merge SHA, publisher run, live SHA on both
endpoints, and the before/after sheet.

## Part 6. The full backlog, prioritised

**HIGH**

- H1. The crown crest repaint (Part 5). Evidence: Dan's 2026-09-13 ruling and
  his 2026-10-05 "IT LOOKS PRETTY GENERIC". The crown is now the most generic
  element on the card. Done means: a new crest that meets all four of the
  spade's criteria is live on all six surfaces and in the share image, the
  old bytes stay intact, and Dan has seen the before/after.

**MEDIUM**

- M1. A real-device check after a real tournament finish. Not done: the prior
  agent verified headless renders at 393px and the live bundles, but never saw
  the card on a phone after a real bust, because that needs a real
  tournament. Do NOT enter a paid event to test. If a zero-buy-in event
  exists, use the platform service identity (not Dan's account; see
  CLAUDE.md 10.10). Otherwise ask Dan to screenshot the card on his phone
  after his next tournament. Check: the X closes it, the reveal plays, the
  payout counts up and lands on the right number, Share opens the sheet with
  the image attached (iOS Safari is the strict case).
- M2. Share PNG size: 912,528 bytes at 1000x1420. Some share targets
  recompress or reject large images. Consider `toBlob(..., 'image/jpeg',
0.9)` (no transparency is needed, the ground is opaque black) or a
  palette-reduced PNG. Measure before and after, keep the File type and the
  filename extension in step, and update
  `tests/components/TournamentRankingCardPolish.test.tsx` if the type
  changes.

**LOW**

- L1. A non-cashing finish reads "Total Payout: 0". It is honest. A softer
  line (for example "No Payout") is a copy decision for Dan, not an agent.
  Ask him before changing it.
- L2. `scripts/ci/entry-chunk-delta.mjs` reports that the baseline is stale
  (six modules left the entry chunk). Refreshing it is `--update-base`, which
  the script calls "periodic refresh only". Leave it unless that is your task.

**Done differently than specified**

- "Remove decimals": the card does not strip all decimals. Whole amounts
  print whole, and real cents stay to the penny ("1.90"). This follows Dan's
  2026-09-04 ruling that chip money under 100 is "ACCURATE TO THE PENNY". The
  no-decimals rule never licenses understating money.
- The foot Close word: the console's own doc says the X is "an addition,
  never a replacement". Dan approved removing it on 2026-10-05, and the card's
  comments record that.

**DECLINED, do not build**

- A crest drawn in SVG, canvas or CSS. If a future agent "fixes" the crown by
  drawing one, that is a mistake. Dan's rule is that crests are painted.

**BLOCKED on a human**

- None for H1 if you have OpenAI image access. If you do not, stop and say so.
  This is the same block the prior agent hit.

## Part 7. Every defect found in this work, and its lesson

1. **The card had no X.** Symptom: Dan's screenshot showed no corner close.
   Cause: `NO_X_BY_DESIGN` in `tests/unit/everyPopupHasAnX.law.test.ts`
   exempted the card with a false reason. Fix: `onClose={onDismiss}` on the
   console, and the exemption deleted. Lesson: an exemption is a claim. Read
   what it points at.
2. **"120.00" and "5,470.00".** Cause: a private `formatMoney` forced two
   places on every chip figure. Fix: `formatPrizeCentsAtUnit` (the estate's
   one prize rule). Lesson: a private formatter is a fork of the money rule.
3. **A bare "1" under "#1".** Cause: `player_number` printed with no label.
   Fix: "ID: 7", the label every other surface uses.
4. **Satellite card: empty pill slot, "-" in the medal, "Qualified" twice.**
   Cause: the card only modelled a finishing place. Fix: the pill names the
   prize, the band reads "Seat Won", and the medal carries the cup. Lesson:
   render every state, not just the happy one. This one was found only
   because the harness rendered it.
5. **A long event name printed microscopically and still clipped**
   ("...TURBO HYPER EDITIO"). Fix: cut at a word, with an ellipsis, over 34
   characters.
6. **The count-up leaked into card text.** Symptom: the card text read
   "Total Payout:5,4700" (final "5,470" plus a running "0"). Fix: the running
   figure is printed by CSS from `data-count`. Lesson: decoration must never
   be a text node.
7. **The count showed decimals the result did not have** ("2,511.27" on the
   way to "5,470"). Fix: a whole target counts in whole chips.
8. **Initial load 321kB against a 320kB gate.** Fix: the card is lazy, and
   the painter is imported on demand.

The shape they share: each was a state or a side channel nobody rendered or
read. The X exemption was never read against the code. The satellite card
and the long name were never rendered. The count leaked through textContent,
and the bundle grew through an import. Render every state, read every
exemption, and measure the bundle.

## Part 8. Traps and instruments that lie

- **Merged is not live.** `publish-club-arena.yml` cancels superseded runs.
  Your merge's own publish run will often say `cancelled`. Find the newest
  successful publish and prove it contains your merge:
  `gh api repos/Smarter-Poker/Smarter-Poker-Club-Arena/compare/<your-merge>...<live-sha> --jq '.status,.behind_by'`
  must print `ahead` (or `identical`) and `0`.
- **CI runner starvation.** On 2026-10-05, 70+ workflow runs were queued with
  1 in progress. Jobs that wait 60 minutes in the queue are cancelled, and
  the aggregate "Client Unit Tests (vitest)" then reports `failure` with no
  test failing. The agent token got HTTP 403 on `.../actions/runs/<id>/cancel`
  and could not re-run jobs. What worked: rebase the branch on current
  `origin/main` and push again, which starts a fresh run. Check job-level
  conclusions (`.../actions/runs/<id>/jobs`) before you believe a red check.
- **`git push --force-with-lease` says "stale info"** in a shallow or
  single-branch clone, because the remote-tracking ref for your branch does
  not exist. Use `--force-with-lease=<branch>:<exact-remote-sha>`.
- **A lint-staged commit can silently do nothing.** If the hook re-formats
  your only staged change back to what HEAD has, the commit is skipped and
  the shell still looks fine. Check `git log -1` after every commit.
- **The full suite's one local failure** (`tests/scopedRuntimeErrors.test.ts`)
  needs `ssh-keygen` on PATH. In a container without it, it fails for that
  reason only. It passes in CI.
- **Harness screenshots taken too early** capture the reveal mid-flight (a
  half-faded medal, a payout at "2,511"). Wait at least 2.6s.
- **The painted-zones law, the palette law and the media law** are
  source-reading tests. They pass or fail on bytes and regexes, not on what
  the card looks like. Look at the render yourself.
- **`fetch` to `ca-static.smarter.poker` from a smarter.poker page** fails
  with CORS ("Failed to fetch"). That does not mean the origin is down. Open
  the URL directly.

## Part 9. Verification commands

Prior work landed (files, not ticks): see Part 2. Each `git cat-file -e` must
exit 0.

Live, after your merge:

```bash
curl -s "https://smarter.poker/hub/club-arena/build-info.json?t=$(date +%s)"
curl -s "https://ca-static.smarter.poker/build-info.json?t=$(date +%s)"
# both: same ca_sha, built_by publish-club-arena.yml; then prove it contains your merge (Part 8)
```

Healthy means both endpoints show the same `ca_sha`, and that SHA contains
your merge commit. If they differ, a publish is mid-flight. Re-check after
the newest `publish-club-arena.yml` run finishes:
`gh api "repos/Smarter-Poker/Smarter-Poker-Club-Arena/actions/workflows/publish-club-arena.yml/runs?per_page=5" --jq '.workflow_runs[] | "\(.head_sha[0:10]) \(.status) \(.conclusion)"'`.

The new art is served:

```bash
curl -sI https://smarter.poker/hub/club-arena/assets/club-buttons/console/spade-console-v1/top-vip-v2.png | head -1   # 200
curl -sI https://smarter.poker/hub/club-arena/assets/club-buttons/console/spade-console-v1/top-vip.png | head -1      # still 200 (old bytes kept)
```

In a browser on `https://smarter.poker/hub/club-arena/`, fetch the live CSS
from `index.html`'s stylesheet links. It must contain `top-vip-v2` (the file
name may carry a hash suffix after the optimizer runs; match the stem).

The build gate, in order: `tsc` clean; the targeted vitest list in Part 5
Step 7, all passing (on 2026-10-05 the related set was 348 tests across 11
files, plus 7 + 3 in the two card test files); `vite build` succeeds;
`bundle-size.mjs` OK at 320kB or under; `entry-chunk-delta.mjs` reports
nothing new.

## Part 10. File map

| Path                                                                          | What                                                                                                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/components/tournament/TournamentRankingCard.tsx`                         | The card (live, lazy). Reveal, count-up, share handler, satellite head                                            |
| `src/components/tournament/TournamentRankingCard.css`                         | The card's styles. Cool palette only (law)                                                                        |
| `src/components/tournament/TournamentRankingHost.tsx`                         | App-root host. `React.lazy` loads the card                                                                        |
| `src/components/tournament/rankingShareImage.ts`                              | Share PNG painter (lazy). Loads `top-vip.png`, which you change to v2                                             |
| `src/components/tournament/rankingTrophy.ts`                                  | Trophy paths and the tier type shared by the card and the painter                                                 |
| `src/components/console/SpadeConsole.tsx` / `.css`                            | The console chassis. Zones, the X, crest classes (`.sc--crest-vip` at CSS line ~90)                               |
| `public/assets/club-buttons/console/spade-console-v1/`                        | Master art. `top.png` (spade, the bar), `top-vip.png` (crown, SEALED), `source/` (painted crests + README recipe) |
| `scripts/art/seat-console-crest.py`                                           | Seats a painted crest and re-mitres the rails. Writes `top-<name>.png`                                            |
| `scripts/art/check-asset-matte.mjs`                                           | `npm run art:matte`, the asset matte check                                                                        |
| `.claude/skills/club-arena-console/SKILL.md` + `harness/`                     | The binding visual standard and the 393px render harness (never commit the harness copies)                        |
| `tests/the-media-optimizer-remembers-and-is-idempotent.law.test.ts`           | Seals the bytes of `top-vip.png` and `crest-vip.png`                                                              |
| `tests/unit/rankingCardPalette.test.ts`                                       | No warm hues in the card CSS                                                                                      |
| `tests/unit/everyPopupHasAnX.law.test.ts`                                     | Every console under a dialog has `onClose`                                                                        |
| `tests/components/TournamentRankingCardPolish.test.tsx`, `...HasAnX.test.tsx` | Pins for the 2026-10-05 fixes                                                                                     |
| `docs/changelog/2026-10-05-the-result-card-*.md`                              | What was done and why                                                                                             |

## Part 11. How to behave on this work

- Fix at the root. No watcher, retry loop or repair job stands in for a fix.
- Pushed, tested, merged, published and verified-live are separate states.
  Claim only the one you proved, with the command that proves it.
- You own push, merge and publish. Dan does not push or deploy. Carry the
  delivery through to verified live.
- Work in long stretches. Dan does not want progress pings every few minutes.
- Measure instead of assuming. Look at renders yourself. A green source-text
  law says nothing about how the crest looks.
- Format and commit only your own files. Never reformat or revert other
  agents' work.
- Write your own changelog file under `docs/changelog/`.
- If something user-visible changes shape beyond the crest (copy, layout,
  what is shown), ask Dan first.

## Part 12. Opening moves, in order

1. Run Part 2 and confirm every prior file is on `origin/main`.
2. Confirm both build-info endpoints (Part 9) and note the live SHA.
3. Read `.claude/skills/club-arena-console/SKILL.md` sections 0, 1, 3.4, 3.6,
   6 and 7, and `public/assets/club-buttons/console/spade-console-v1/source/README.md`.
4. Set up the harness with fonts and shoot the "before" set: the result card
   and the VIP cards modal, crown and spade.
5. Paint three candidates (Part 5 Step 1), seat each as `vip-v2`, and render
   each.
6. Pick or repaint against the four criteria. If unsure, ask Dan with the
   sheet.
7. Wire, gate, push, PR, checks, merge, verify live (Part 5 Steps 4 to 9).
8. While waiting on CI, take M2 (share PNG size) on a separate branch.

Never overwrite `top-vip.png` or `crest-vip.png`. Ship the new crest under new
file names.
