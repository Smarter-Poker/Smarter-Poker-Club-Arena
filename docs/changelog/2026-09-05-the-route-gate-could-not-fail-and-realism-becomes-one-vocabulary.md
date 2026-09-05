# The route gate could not fail, and realism becomes one vocabulary (2026-09-05)

Dan: "improve every layer of the UI all of its pages, sub pages, buttons
frames, graphics and everything and anything else using #SmarterCasinoRealism.
make sure your checking every page and route audits and enhancements, every
clickable link needs to be explored, audited, enhanced, improved and upgraded
before claiming success."

Two things came out of that. One is a guard that has been reporting OK without
being able to say anything else. The other is a correction to how "realism
everywhere" can actually be delivered in a CSS Modules app.

## 1. `check-route-targets.mjs` was vacuous, and it is the guard for exactly this

The gate exists to catch a navigation that lands nowhere. Asked to prove it
works, it did not:

```
$ printf 'navigate("/this-route-does-not-exist-anywhere-xyz")' >> src/pages/PlayerStatsPage.tsx
$ node scripts/ci/check-route-targets.mjs
[check-route-targets] 132 declared routes, 69 navigate() targets - allowlisted: 0
[check-route-targets] OK - every navigate() target matches a declared route.
exit=0
```

Two causes, both in one line of `toMatcher`:

```js
if (clean === '' || clean === '*') return /^.*$/;
```

- `path="*"` is the NotFound catch-all. Compiling it to a matcher that accepts
  everything means every target "matches". And the catch-all is precisely WHY
  this failure is silent in the first place: the player is dropped on NotFound
  rather than the surface the button promised, so a gate that counts it as a
  match can never fire.
- `path="/"` reduces to `clean === ''` and fell into the same branch, so the
  index route also matched every path in the app.

`path="*"` sits at App.tsx:1998. The gate has been unable to fail since it
arrived.

**Fixed:** both are excluded from the matcher set (the index route is answered
directly by `matches()`); a nested splat like `legal/*` is still a real prefix
route and stays a matcher.

### Then it was widened, because a `<Link>` is as clickable as a navigate

The gate only ever read `navigate()`. It now also reads `<Link to>` /
`<NavLink to>` - **84 targets that had never been checked** - and, separately,
`<a href="/...">`, which is a different bug: the app mounts at
`basename="/hub/club-arena"`, so a bare href is a full page load to an origin
path that does not exist. Both `ClubFinancialDashboard` and `CashierPage` carry
comments about having been bitten by that, so it is a known house shape.

### And it was taught to ignore comments, which is the interesting part

The first run of the widened gate reported six failures. **All six were comment
prose** - `navigate('/hub/club-arena')` and `<a href="/clubs/...">` quoted
inside the block comments that record those exact bugs being fixed. A gate that
fails on the changelog of its own bug gets allowlisted by the next agent, and
then it is vacuous a second way. It now blanks comments before scanning,
preserving byte offsets so reported line numbers stay true.

**Result on the current tree:** 132 declared routes, 250 `navigate()` + 84
`<Link>`/`<NavLink>` targets across 74 distinct paths, every one resolving;
zero basename-escaping hrefs. Re-verified that it still fails on a planted dead
navigate and on a planted bare href.

## 2. Every route was walked, in the browser, on production

Not grepped - loaded. All 41 parameter-free routes, signed in, console
instrumented:

- every route rendered content; **no blank pages, no dead ends**;
- **one** console error in the whole app (`/clubs/create`);
- two routes that looked wrong and are not: `/clubs/create` is a deliberate
  `<Navigate to="/?create=club">`, and `/waitlist` is a deliberate
  `<Navigate to="/">` with a written reason (the queue lives where the tables
  are). Both render the home fingerprint because both are redirects.

## 3. Realism: the premise was wrong, and the measurement is now in the code

The plan was to put material on the global primitives - `.btn`, `.card`,
`.badge` - on the grounds that grep finds them in 135, 81 and 71 files. Walking
ten live routes first (592 buttons and 142 links actually rendered) found
`.btn` **once** and `.card`, `.badge`, `.skeleton` **not at all**. Club Arena
is CSS Modules end to end. Styling those primitives and calling it an app-wide
restyle would have been a no-op sold as a win, so the claim was cut and the
measurement written into the sheet where the next agent will read it.

What was done instead:

- **One vocabulary.** `--realism-*` tokens - the wallet's approved palette plus
  the three light effects a machined surface is built from (bevel, cavity,
  lift) - now live once on `:root` in `club-engine.css`, the only token sheet
  `main.tsx` actually loads. (`design-system.css` and `design-tokens.css` both
  define tokens and neither is imported; the realism tokens do not become a
  third decoy.) Pages draw from it instead of inventing a ninth palette.
- **Global chrome that no module owns**: the keyboard focus ring is energy
  cyan, and scrollbars are gunmetal, part of the cabinet.
- **The one genuinely shared surface: the Rewards Circuit header**, which
  renders on **19 pages** and is not approved artwork. It now draws from the
  tokens, with the previous literal as a fallback on every `var()`, and carries
  the machined frame. This closed a real drift: it lit its live metrics
  `#3aa8ff` while the wallet - the approved reference for
  #SMARTERCASINOREALISM - runs `#00d4ff`. Two pages in the same family, one tab
  apart, glowing a different colour.

**The global header is deliberately untouched.** It is the only module sheet on
every single route, and it is Dan-approved artwork (2026-08-29) with its own
guard law. Restyling it is how the hamburger revert war started.

## What is NOT done, stated plainly

Realism is now a vocabulary plus two shared surfaces. It is **not** on all 132
routes - each remaining page carries its own module stylesheet and is its own
piece of work. `tests/realism-is-one-vocabulary.law.test.ts` pins the
vocabulary and the shared header and deliberately asserts nothing about
per-page coverage, because a law that pinned a fiction would be worse than no
law.

## 4. The app was running in LIGHT MODE on production, via the felt attribute

Auditing the VIP page's palette found it styled against `var(--bg-primary)`
and `var(--bg-secondary)`. Asking the live page what those resolve to:

```
data-color-theme="light"     data-theme  (unset)
club-arena-table-settings.theme === "light"
club-arena-user-settings.theme  === "dark"
--bg-primary  #f0f4f0        --bg-secondary  #e8ede8
```

Near-white, on the platform whose standing rule is "THE WHOLE BACKGROUND
SHOULD BE SOLID BLACK AND ALL THE SAME COLOR", for a player whose interface
setting says **dark**.

This is the same one-thing-two-meanings shape `settingsHaveOneOwner.test.ts`
was written about, and it **survived the fix meant to end it**. `data-theme`
once carried both the table FELT colour and the light/dark interface MODE;
useTableSettings.ts documents that fight, splits them, and states the intent:
"`data-theme` itself now belongs exclusively to the light/dark interface mode."

Two things were left behind:

1. `design-tokens.css` gave **both** attributes to every palette - including
   `light`, which is not a felt palette at all. So `data-color-theme="light"`
   still selected the whole light token set.
2. `theme` is typed `string` with no validation, so the stale value written by
   the very bug the split repaired kept being stamped onto the DOM on every
   page load, forever.

**Fixed at both ends.** The light rule is `[data-theme='light']` only (the five
felt palettes keep both attributes, so no skin changed). `useTableSettings`
gained `FELT_THEMES` and coerces at both doors - on load, and in
`applySideEffects`, which matters because a bus message from another tab and a
server settings row never pass through load().

**Verified on the live page**, all three states:

| `<html>` state                         | `--bg-primary` | `--text-primary` |
| -------------------------------------- | -------------- | ---------------- |
| `data-color-theme="light"` (the bug)   | `#f0f4f0`      | `#1a2e1a`        |
| `data-color-theme="black"` (coerced)   | `#0a0e17`      | `#f3f4f6`        |
| `data-theme="light"` (the real toggle) | `#f0f4f0`      | `#1a2e1a`        |

Dark is restored, and light mode still works from the attribute that owns it.
Pinned by four new assertions in `tests/unit/settingsHaveOneOwner.test.ts`
(28 -> 32).

## 5. RakebackPage joins the vocabulary

One tab from the wallet, and it had independently reached the right idea - it
already lit its figures `#00d4ff` and already had a bevel. What it did not
share was the greys: `#2a3a4a` borders against the family's `#27313c`,
`#6a7a8a`/`#8a9aaa` labels against `#7f8c9b`. Each correct alone, mismatched
side by side. Now sourced from `--realism-*` with the previous literals as
fallbacks, and its summary cards gained the cavity and lift so they sit IN the
page rather than on it.

## 6. The realism layer broke ten approved looks, and CI caught what reasoning had not

Written down because it is the most expensive thing learned here.

The layer shipped with `* { scrollbar-color }`, four `*::-webkit-scrollbar*`
rules and a `:focus-visible` outline override. The reasoning: scrollbars and
the focus ring are chrome no module owns, so styling them globally is free.

**CSS Beat E2E, a required check, went red.** The failing spec is
`customization-studios.spec.ts` > "all ten coordinated looks retain their
mobile, tablet, light, dark, and final-table visuals", which compares **thirty
committed screenshots** of the approved Table Studio looks at
`maxDiffPixelRatio: 0.02`. `ThemeSettingsModal.css` carries 32 overflow
declarations, so a universal `::-webkit-scrollbar { width: 10px }` changed
scrollbar GEOMETRY inside every one of its scroll containers.

**Authorship was measured, not assumed.** `main` was green on every run; the
**first** commit of this layer was red, and it carried nothing but this
stylesheet, one module header and a CI script. By elimination the studio uses
none of `.card`/`.btn`/`.badge`/`.skeleton` - its markup is BEM
(`theme-asset__tier-badge`, `studio-game-preview__*`) - so the universal
selectors were the only rules of ours that could reach those baselines.

**A local A/B could not reproduce it, and that matters.** Running the spec on
this Mac passed BOTH with and without the rules (16.4s and 14.6s, exit 0),
because macOS draws overlay scrollbars that occupy no layout space; only Linux
CI reserves real width. Reasoning about blast radius - and even a local
reproduction attempt - is not a substitute for the pixel baseline.

**Fixed** by deleting all six rules. The tokens and the `.card`/`.btn`/
`.badge`/`.skeleton` material stay, because those are opt-in by class.
`tests/realism-is-one-vocabulary.law.test.ts` gained a pin that fails if any
universal selector or `:focus-visible` override re-enters the layer, verified
in both directions (red with one planted, green without).

**The rule this leaves behind:** realism is OPT-IN. A page asks for it by
reading `--realism-*`. It is never imposed from `*` in the one globally loaded
stylesheet, which reaches every surface in the app - including approved artwork
with pixel baselines.

## 7. The wallet's own background had never rendered, and two of its class names leaked

A line-by-line pass over everything above, after publication, found four more
defects. Three of them were mine.

**The realism reference was being repainted by the family sheet.**
`RewardsCircuitSurfaces.css` listed `.wallet-page` in a `:is()` that sets the
page ground with `!important`. Measured on the live published page:

```
computed background-image   radial-gradient(... rgba(58,168,255,.09) ...)   <- the family's blue
the wallet's own rule       radial-gradient(... rgba(0,212,255,.08) ...)    <- present, and losing
```

So the page every other Rewards Circuit surface is converging _toward_ has
never once shown the cyan vault ground written for it, and every realism pass
over it was invisible. The wallet is out of that list now and keeps only the
family's text colour; the other six destinations are byte-identical.

**Five selectors in that sheet pointed at markup deleted in the rebuild.**
`.wallet-page .wallet-hero`, `.wallet-card-premium`, `.transfer-section`,
`.hero-btn`, `.transfer-btn` - all measured rendering **zero** times against
the current page, which emits `vault-hero`, `vault-panel`, `vault-btn`. Dead
since the rename. Deliberately NOT remapped onto the new names: those rules are
`!important` and would overpaint the machined surfaces with the generic ones,
which is the same defect as the ground, one level down.

**`.message` was a live cross-page collision.** `PlayerWalletPage.css` and
`ChipTransferModal.css` both declared it bare, with different padding
(10px 12px against 0.875rem 1rem), weight (600 against 500) and error red
(`#ff8a8a` against `#ef4444`). Both are plain `.css`, so the winner was
whichever chunk the player loaded last: open the agent chip-transfer modal and
then the wallet, and the send banner came out in the modal's metrics. Scoped to
`.wallet-page .message`.

**Main was RED on `global-css-does-not-leak-across-pages`** - 244 leakable
classes against a ceiling of 243, reproduced on a pristine checkout, so not
this branch's doing. Rule 5.8 puts that ahead of my own work. The two fixes
above took it to **242**, and the ratchet is lowered to match rather than
raised to pass.

**Three utility classes were deleted as speculative.** `.realism-frame`,
`.realism-readout` and `.realism-label` shipped in the global layer with
**zero** consumers across every `.tsx` and `.ts`. The vocabulary is the tokens,
which are genuinely consumed by three stylesheets; a page wanting a machined
frame writes it in its own sheet from `--realism-bevel` and `--realism-cavity`,
which also keeps it inside the module boundary.

**And the felt-theme guard was checked against production rather than trusted.**
`FELT_THEMES` is a hand-maintained list of five, and the studio catalog carries
twelve ids (`classic_green`, `ocean_blue`, `jade_city` ...), so a mismatch would
silently reset a player's table. `user_table_settings.color_theme` holds exactly
three distinct values across all players - `black`, `gold`, and the one
contaminated `light` - so nobody is reset. A new assertion now derives the legal
set from `design-tokens.css` instead of trusting the retyped list, and fails if
a sixth palette is added without updating it.

**The route gate got the test it never had.** Its comment-blanking parser is now
its most dangerous component: over-stripping produces a false negative, which is
worse than the vacuum it replaced. `tests/unit/routeTargetGateParser.test.ts`
pins 18 cases, including the ones that look like comments and are not - a regex
holding escaped slashes, a division, a URL, an apostrophe inside a comment, a
comment marker inside a string - and that byte offsets survive, so reported line
numbers stay true.

## Verification

- `npx tsc --noEmit`: exit 0.
- `npx vitest run tests/`: **1000 of 1001 test files pass**. The one failure is
  `the-media-optimizer-remembers-and-is-idempotent.law` failing to import
  `sharp`, which is declared (`^0.34.5`) but absent from local `node_modules`;
  it fails identically on untouched `main` in the other clone, and CI's
  `npm ci` installs it.
- `no-hover-effects.law` and `animations-always-play.law` both green; the only
  `:hover` strings added anywhere are prose naming those laws.
- Route gate re-verified in both directions: green on the tree, red on a
  planted dead navigate and on a planted bare href.
- The Rewards header was checked on the live production page with the new rules
  injected, at phone width.
