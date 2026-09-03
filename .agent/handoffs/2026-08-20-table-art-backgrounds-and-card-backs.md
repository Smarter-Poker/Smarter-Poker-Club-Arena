# ANTIGRAVITY HANDOFF — Table backgrounds + card back artwork

**Repo:** `Smarter-Poker-Club-Arena` (`~/Documents/club-arena`)
**Created:** 2026-08-20 · **Author:** Claude (Cowork) · **For:** Antigravity (image-gen capable agent)
**Why a handoff:** this needs original artwork generated. Every code path is already
built, tested and shipped — what is missing is pixels. Do not re-architect the
resolvers; they are correct and covered by 28 tests.

---

## 0. TL;DR — what to produce

| #   | Deliverable                                          | Count | Where it goes                                |
| --- | ---------------------------------------------------- | ----- | -------------------------------------------- |
| A   | Table background artwork (brighter, landscape-aware) | 10    | `src/assets/backgrounds/`                    |
| B   | Missing store card-back previews                     | 4     | `public/cards/backs/`                        |
| C   | Real card-back artwork for the table                 | 8     | `public/cards/backs/table/` (new)            |
| D   | Code wiring for C + de-aliasing the exclusives       | —     | `CardImage.tsx/.css`, `CardBackSelector.tsx` |

A and B are **drop-in art only, zero code changes**. C and D go together.
Ship A+B first as one PR, then C+D. Do not bundle them.

---

## 1. Background context (read before generating anything)

The ten designed table backgrounds are **technically wired correctly and visually
invisible**. Measured from the actual files on 2026-08-20:

```
bg_carbon_grid.jpg     750x1624  avg RGB (16,18,22)  brightest pixel 33/255
bg_crimson_lounge.jpg  750x1624  avg RGB (49,13,18)  brightest 50
bg_emerald_room.jpg    750x1624  avg RGB (11,40,28)  brightest 50
bg_galaxy.jpg          750x1624  avg RGB (18,17,43)  brightest 62
bg_golden_dusk.jpg     750x1624  avg RGB (64,46,18)  brightest 85
bg_ice_frost.jpg       750x1624  avg RGB (33,48,65)  brightest 92
bg_jade_neon.jpg       750x1624  avg RGB (9,32,24)   brightest 41
bg_midnight.jpg        750x1624  avg RGB (22,26,32)  brightest 49
bg_ocean_abyss.jpg     750x1624  avg RGB (10,31,54)  brightest 60
bg_royal_indigo.jpg    750x1624  avg RGB (29,24,57)  brightest 69
```

Two independent problems:

1. **Too dark.** A brightest pixel of 33–92 out of 255 behind a dark table reads
   as a black page. Dan's report was literally "EVERY SINGLE TABLE NEEDS A
   BACKGROUND... IT SHOULD NEVER BE BLANK."
2. **Portrait-only.** All ten are 750x1624 (phone portrait). The page uses
   `background-size: cover`, so on a 1400x1100 desktop viewport the browser
   scales to fill width and crops ~78% of the height away — you see a
   near-uniform slice from the middle, which carries no design at all.

A CSS ambience layer now sits above the artwork (translucent light pool +
vignette) and a pure-CSS floor below it, so the page can never be blank even if
an asset 404s. **That is a safety net, not a substitute for artwork.** Your job
is to make the designs actually worth looking at.

---

## 2. Deliverable A — 10 table backgrounds

### Filenames (EXACT — these are Vite-imported by name; same name = zero code change)

`src/assets/backgrounds/` — replace in place:

```
bg_midnight.jpg        bg_royal_indigo.jpg    bg_emerald_room.jpg
bg_crimson_lounge.jpg  bg_ocean_abyss.jpg     bg_golden_dusk.jpg
bg_galaxy.jpg          bg_carbon_grid.jpg     bg_ice_frost.jpg
bg_jade_neon.jpg
```

Imported at `src/assets/tableAssets.ts:39-48`. Keys in `TABLE_BACKGROUNDS`
(`midnight`, `royal_indigo`, ...) map 1:1 to these filenames. **Do not rename
anything** — ids are persisted in `user_theme_settings.background_id` in
production and will outlive any rename.

### Specification

- **Dimensions:** `2560 x 1440` (16:9 landscape). This is the change that fixes
  desktop. Compose for 16:9 but keep the **centre 60% x 60% safe** — see below.
- **Format:** JPEG, quality ~82, target **≤ 320 KB each** (current set averages
  145 KB; the budget check in CI watches bundle size).
- **Brightness target:** mean luma **55–85**, brightest pixel **180–235**.
  Verify with the script in §6. Do not blow out to white — this sits behind a
  dark table and must not compete with it.
- **Composition — critical:** the poker table occupies a centred ellipse roughly
  **60% width x 62% height**. Put NO detail there. All the design interest
  (architecture, light sources, texture) belongs in the outer band. Think of it
  as a room photographed from above the table.
- **Mobile crop safety:** at 375px wide portrait the browser crops to the
  centre ~35% of the width. That vertical centre strip must still look
  intentional on its own. Test both crops before delivering.
- **Colour:** each design keeps its existing identity (see the id list). They
  must be clearly distinguishable from one another in a 3-across picker grid at
  ~120px wide — that is the actual UI they appear in.

### The ten identities (keep these, just execute them properly)

| id               | Direction                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `midnight`       | The default. Deep blue-black lounge, cool rim light, subtle haze. Must be the safest, most neutral of the set. |
| `royal_indigo`   | Indigo/violet, velvet drapes, warm accent lamps.                                                               |
| `emerald_room`   | Deep green private room, brass fittings, warm pooled light.                                                    |
| `crimson_lounge` | Red leather, low warm light, cigar-lounge mood.                                                                |
| `ocean_abyss`    | Deep teal-blue, caustic light from above, cool.                                                                |
| `golden_dusk`    | Warm amber, low sun through blinds, dust in the light.                                                         |
| `galaxy`         | Star field + nebula, cool violet/blue, no sun.                                                                 |
| `carbon_grid`    | Carbon fibre / tech grid, near-monochrome with cyan accent.                                                    |
| `ice_frost`      | Pale blue-white, frost and glass, coldest of the set.                                                          |
| `jade_neon`      | Jade green with neon signage glow, night-city.                                                                 |

---

## 3. Deliverable B — 4 missing store card-back previews

`public/cards/backs/` is missing artwork for four designs that **the store
actively sells**:

```
holographic.webp   (sells for 200 diamonds)
carbon.webp        (175)
club-branded.jpg   (250)   <- "Club Crest"
diamond-foil.jpg   (300)
```

Catalog lives at `src/components/customization/CardBackSelector.tsx:55-153`.
The eight that DO exist: `black, red, blue, white, classic, burgundy, navy, gold`.

### Specification

- **Dimensions:** `1696 x 2528` (matches `black/red/blue/white.webp`). The four
  older ones are 686x1024 — regenerate those at 1696x2528 too if you have
  capacity, but the four missing ones are the blocker.
- **Format:** `.webp` for `holographic` and `carbon`, `.jpg` for `club-branded`
  and `diamond-foil` — **the extensions are hard-coded in the catalog**, match
  them exactly or update the catalog in the same commit.
- **Framing:** full-bleed card back, no rounded corners baked in (CSS applies
  the radius), no drop shadow, no white margin.
- **Design:** these are the premium tier — they must look obviously more
  valuable than the free black/red/blue/white. `holographic` = iridescent
  rainbow sheen; `carbon` = woven carbon fibre with a metal edge; `club-branded`
  = a heraldic crest suitable for a poker club; `diamond-foil` = faceted
  diamond-pattern foil, silver/white.

Until these land, the store shows a styled per-design gradient placeholder
(not a broken image) — that fallback is already shipped and should stay.

---

## 4. Deliverable C + D — real card backs AT THE TABLE

**This is the one that matters most and it is currently invisible to everyone.**

The store sells twelve image-based card backs. The table renders card backs as
**flat two-stop CSS gradients** — `src/components/table/CardImage.css:115-152`,
eight of them, no artwork whatsoever:

```css
.card-back--classic_red  { --cb-gradient: linear-gradient(135deg,#8b0000,#4a0000); }
.card-back--classic_blue { --cb-gradient: linear-gradient(135deg,#1e3a5f,#0d2137); }
.card-back--diamond      { ... }  .card-back--gold   { ... }
.card-back--dragon       { ... }  .card-back--neon   { ... }
.card-back--galaxy       { ... }  .card-back--royal  { ... }
```

So a player buys "Diamond Foil" for 300 diamonds and, at the table, sees a
purple gradient. As of commit `ba385fc83` every purchasable id at least maps to
a distinct real design (aliases in `CardImage.tsx`), so purchases are honest —
but they are still gradients.

### C — artwork

Produce **8** table-resolution card backs in a NEW folder `public/cards/backs/table/`:

```
classic_red.webp   classic_blue.webp   diamond.webp   gold.webp
dragon.webp        neon.webp           galaxy.webp    royal.webp
```

- **Dimensions:** `500 x 750` (2:3). These render as small as 34px wide on a
  seat, so the pattern must survive heavy downscale — bold central motif, high
  contrast, no fine filigree.
- **Format:** `.webp`, quality ~85, **≤ 40 KB each**. Eight of these ship to
  every player on every hand; weight matters more than fidelity here.
- **Design:** match the existing gradient palettes so nothing changes character
  (the hex values above are the brief). Add a central emblem and a border
  treatment. Must read as a _card back_, i.e. rotationally symmetric or close
  to it, with a clean border inset.

### D — wiring (small, do it in the same PR as C)

1. `CardImage.css` — keep `--cb-gradient` as the fallback and add a
   `--cb-image` custom property per design; base `.card-back` rule becomes
   `background: var(--cb-image, none), var(--cb-gradient); background-size: cover;`
   so a missing image degrades to today's gradient rather than to nothing. **Keep
   that fallback** — it is the same never-blank principle as the table background.
2. Once `holographic / carbon / club-branded / diamond-foil` artwork exists
   (Deliverable B), give them **real entries** in `CARD_BACK_IDS` + their own CSS
   designs, and **remove** their aliases from `CARD_BACK_ALIASES` in
   `CardImage.tsx`. Leave the legacy aliases (`classic`, `black`, `blue`, `red`,
   `white`, `burgundy`, `navy`) alone — those are stored in production settings.
3. Update `tests/unit/cardBackVocabulary.test.ts` — it currently asserts the four
   exclusives resolve to four DISTINCT designs. Once they are real ids that test
   should assert they resolve to _themselves_.

---

## 5. Repo rules you must follow (non-negotiable, CI-enforced)

- **No emoji anywhere in source files.** Breaks the SWC compiler and fails the Vercel build.
- **Never call AI players "bots"** — they are horses.
- **Mobile-first**: verify at 375px width before anything else.
- **Do not run** `vercel deploy`, `vercel --prod`, or any deploy hook.
- **Deploy path:** push to `main` on `Smarter-Poker-Club-Arena`. CI
  (`.github/workflows/build-for-world-hub.yml`) builds and syncs `dist/` into
  `Smarter-Poker-World-Hub/public/hub/club-arena/`, which triggers Vercel. One
  push = one deploy. Never edit `public/hub/club-arena/` in World Hub directly.
- **Commit author must be** `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>`
  or `github-actions[bot]`. Vercel BLOCKS deployments it cannot attribute — this
  cost five blocked production deploys on 2026-08-19.
- **Concurrency:** other agents are actively editing `src/pages/TablePage.tsx`,
  `src/pages/HomePage.tsx`, `src/components/table/SeatSlot.tsx`,
  `src/components/table/CommunityCards.tsx` and `server/**`. Do not touch those
  files. If your change needs one of them, stop and write a follow-up handoff.
  Build and verify in a **git worktree off `origin/main`**, not in the shared
  working tree — it is routinely dirty with other agents' in-flight work.

---

## 6. Acceptance criteria — do not claim done until every line passes

```bash
# 1. Brightness + dimensions of the new backgrounds
cd ~/Documents/club-arena && python3 -c "
from PIL import Image; import glob
for f in sorted(glob.glob('src/assets/backgrounds/*.jpg')):
    im=Image.open(f).convert('RGB'); px=list(im.resize((64,64)).getdata())
    mean=sum(sum(p) for p in px)//(len(px)*3); mx=max(sum(p) for p in px)//3
    ok = im.size==(2560,1440) and 55<=mean<=85 and 180<=mx<=235
    print(('PASS' if ok else 'FAIL'), f.split('/')[-1], im.size, 'mean',mean,'max',mx)
"
# every line must read PASS

# 2. No missing store card-back asset
for n in holographic carbon club-branded diamond-foil; do
  ls public/cards/backs/$n.* >/dev/null 2>&1 && echo "OK $n" || echo "MISSING $n"; done

# 3. Gates
npx tsc --noEmit          # must be silent
npx vitest run            # 2210+ passing, 0 failing
NODE_ENV=production npm run build   # must exit 0
npx prettier --check src/ # must pass

# 4. Post-deploy: confirm production serves YOUR build, not a cached one
#    (get the CA sha from the World Hub "sync build <sha>" commit, then:)
curl -sL "https://smarter.poker/hub/club-arena/index.html?cb=$(date +%s)" \
  | grep -o 'index-[A-Za-z0-9_-]*\.js'
#    and confirm the hashed background asset is reachable:
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://smarter.poker/hub/club-arena/assets/<bg_midnight-HASH>-v6.jpg"   # expect 200
```

Visual acceptance (a human or a screenshot pass, not just green tests):

- Open a table at **375px** and at **1440px**. The background must be clearly
  visible and clearly _designed_ at both, and must not compete with the felt.
- Open Settings → Card Back Design. All twelve tiles show real artwork, none
  show a gradient placeholder, none show a broken-image glyph.
- Equip a premium back, sit at a table, and confirm the back you paid for is the
  back on the cards.

---

## 7. Do NOT change

- `src/lib/tableTheme.ts` — the layer resolver, ambience and never-blank floor.
  Covered by 28 tests; it is correct.
- `resolveBackground` / `resolveSkin` fallback behaviour.
- Any background **id** or card-back **id** already in `TABLE_BACKGROUNDS`,
  `CARD_BACK_IDS` or `CARD_BACK_ALIASES` — they are persisted in production
  (`user_theme_settings`, user settings JSON) and renaming one silently resets
  real players' choices.
- The placeholder / gradient fallbacks. They are the reason a missing asset
  degrades instead of breaking, and they must survive your changes.

---

## 8. Nice-to-have, only after the above ships

- `@2x` variants + `image-set()` for the backgrounds on retina.
- A blurred-edge variant so ultra-wide (21:9) does not crop the composition.
- Real artwork for the four _table_ skins that are currently unused aliases.
- An `og:image` for club share links (none exists today).
