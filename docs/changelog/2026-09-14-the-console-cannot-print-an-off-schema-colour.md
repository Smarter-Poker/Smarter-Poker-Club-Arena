# The console cannot print an off-schema colour

**2026-09-14**

`#ClubArenaConsole` has told agents to "stick to the Smarter.Poker color schema"
since version 1.0 without anywhere saying what that schema is. Dan defined it on
2026-09-14:

> "PRIMARY COLOR SCHEMA IS BLACK, BLUE, TEAL, SILVER, WHITE, AND COLORS USED
> INSIDE THE CLUB ARENA"
>
> "YELLOW AND ORANGE ARE NOT REALLY USED, OR ARE USED IN LIMITED CAPACITY"
>
> "PURPLES, PINKS, REDS, AREN'T USED OFTEN AND SHOULD BE ONLY USED WHEN
> ABSOLUTELY REQUIRED"
>
> "FELT IS NOT GREEN BY DEFAULT, ITS BLACK BY DEFAULT (IT CAN BE CHANGED BY THE
> USER)"
>
> "FACEBOOK COLOR SCHEMA FOR THE SOCIAL MEDIA PAGES IS EXCLUDED FROM ANY AND ALL
> COLOR SCHEMAS. THATS ITS OWN INDIVIDUALLY OWNED COLOR SCHEMA"

## What changed

`SKILL.md` §3.4 now states the schema instead of gesturing at it: the five
colours, what each restricted colour's one job is, the Facebook exclusion, and
the felt ruling. The three rulings are in Dan's law table (§1), the guard is in
the definition of done (§10), and the version is 1.2.0.

`tests/the-console-prints-only-schema-colours.law.test.ts` is the part that
cannot be talked past. Prose is advice — the twenty-four "shadow" stops Dan
rejected on sight on 2026-09-13 were each written by an agent that had read the
instruction and agreed with it.

## Why an allowlist, and why it did not cost a cleanup

A ban list only ever catches the last mistake. This is an allowlist: a literal
that is not on it fails the build, and the failure names the colour and points
at §3.4.

That is normally expensive to introduce. It was not here, because the console
kit was measured first and was already compliant — seventeen distinct literals
across the four surfaces, every one of them black, silver, blue, teal or white
plus the three restricted inks. No browns, no pinks, no purples, no oranges.
This law locks in a state the kit was already in. **No existing file was
changed.**

Verified by injecting `#8b4513` and `#1877f2` into `SpadeConsole.css`: the suite
fails and reports

```
src/components/console/SpadeConsole.css paints #8b4513 — brown — Dan: "NO BROWNS
OR PINKS". See SKILL.md §3.4.
```

## What is deliberately not guarded

- **`src/components/social/**`.** Those surfaces run the Facebook schema, which
Dan owns separately. `--fb-blue #1877f2` is correct there and banned on a
  console surface. The test asserts the exclusion structurally, so a later agent
  cannot quietly widen the guard onto those files and start failing builds over
  colours that are right where they sit.
- **The felt and the table themes.** A felt is a player preference with its own
  preset list.
- **The rest of the repo.** This law is scoped to what `#ClubArenaConsole`
  governs. Widening it is separate, deliberate work.

## One thing left open

`src/styles/design-tokens.css` still ships `--felt-color: #0f5132` as the default
preset, which contradicts the felt ruling. Changing the default table surface is
a gameplay-surface change with real visual blast radius, not a console one, so it
is recorded in §3.4 as a note and left for its own branch rather than smuggled
into a documentation pass.
