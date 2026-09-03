# 2026-08-31 — Navigation Law Phase 2: Title Case At The Source, Every Surface

Phase 1 (2026-08-30, PR #2006) made the hamburger case its own labels at render
and pinned that every hamburger destination resolves to a real route. This is
the same two rules applied to the other five navigation surfaces, and the fix
moved from the render site to the source.

## The gap

`scripts/ci/check-title-case.mjs` states in its own header:

> WHAT IT DOES NOT TOUCH
>
> - anything inside {} - those are expressions, and their values are cased at
>   their source (or by formatPopupText for toasts)

That is the right call for a parser — it cannot tell a CSS value from prose —
but it makes a promise, and **nothing enforced the promise**. Every navigation
surface in Club Arena renders its copy from a config registry through an
expression (`{item.label}`):

    HamburgerMenu · ArenaSectionRail · ClubOperationsRail
    QuickActionsBar · ClubBottomNav · Breadcrumbs

So all navigation copy fell between the two halves of the rule. Measured:
**55 `label` / `description` / `eyebrow` literals** across the three navigation
registries had never been Title Cased by anything, and could not have been
caught by the only gate that looks for this. Phase 1's render-side `tc()` fixed
what a player saw in one drawer and left the same strings wrong everywhere else
they render.

## What changed

- **New gate `scripts/ci/check-nav-title-case.mjs`** (with `--fix`). Parses the
  navigation registries with the TypeScript compiler and requires every
  `label` / `description` / `eyebrow` string literal to already be Title Cased.
  Shares its acronym list and casing function byte-for-byte with the sibling
  gate — two gates that disagree about the rule would undo each other forever.
  Scope is deliberately narrow (six named files, three keys): these are
  registries whose every string is menu copy by construction, which is what
  makes casing them unambiguous. It is **not** widened to "all string
  literals" — that is the mistake the sibling gate correctly refused to make.
- **55 violations fixed at source** across `clubArenaNavigation.ts`,
  `clubOperationsNavigation.ts`, `clubIntegrityNavigation.ts`.
- **Three computed (ternary) descriptions** on the Operations Center item cased
  by hand — they are not string-literal property assignments, so the AST gate
  cannot see them. Found by the new law test, not by the gate, which is the
  point of having both.
- **`QuickActionsBar.tsx` and `ClubBottomNav.tsx` added to the gate's scope**
  even though their labels were already correct, so they cannot quietly stop
  being correct. A rule that covers only what is currently broken is a cleanup,
  not a gate.
- **Wired into all three places** the sibling copy gates run: `.husky/pre-push`,
  `.github/workflows/ci.yml`, `scripts/ci/all-gates.sh`. (`check-title-case`
  ran only in the local hook until 2026-08-22 and main went red three times in
  one day because API-side pushes never touched it.)

## Route connectivity, re-verified across every surface

All **59** destinations every registry can produce at maximum permission —
hamburger, support nav, all six section rails including both union shapes, the
full club operations workspace and the integrity nav — resolve to routes
declared in `App.tsx`. **Zero dead links.** Asserted by CALLING the registry
builders, not by reading their source: two of them compose paths from a
template (`/clubs/${clubId}/${suffix}`), so a source-text audit reports them as
unresolvable and proves nothing.

## Enforcement

`tests/unit/navigationSurfacesLaw.test.ts` (7 tests) pins: every destination
resolves to a route; every label and description is Title Cased; the gate covers
all six files and all three keys; the gate is wired into pre-push, CI and
all-gates; and the two gates share one definition of Title Case. It also asserts
the collection is non-empty per surface, so a builder that silently returned `[]`
cannot make the suite vacuously pass.

## Verification

- New gate proven in both directions: fails on a seeded lowercase label
  (exit 1), passes once restored (exit 0).
- `npx tsc --noEmit` exit 0.
- `navigationSurfacesLaw` + `hamburgerMenuLaw`: 39 tests green.
- Sibling gates `check-title-case` and `check-ui-text` still green after the
  55-string rewrite.
