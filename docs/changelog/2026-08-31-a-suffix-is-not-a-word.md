# 2026-08-31 — A suffix is not a word

The casing sweep that closed the attribute, template, ternary and i18n gaps
(#2295 line of work) also cased two things that are not words. Both shipped.

## What players are seeing right now

**On the club home page, three times on one screen:**

> 3 Game**S** Are Open In This Club

**On five labels, two of them `aria-label`:**

> View Alice**'S** Profile

The second is the worse of the two. `aria-label` is what a screen reader
announces, and it reads that as "Alice apostrophe S Profile".

## Both are the same mistake in two costumes

A fragment that FINISHES the word before it got treated as a word of its own:

```
Game{n === 1 ? ' is' : 's are'} Open In    the 's' completes "Game"
`${username}'s Profile`                    the 's' completes the name
```

`check-title-case`'s own header already warned about exactly this:

> that particular one is the plural suffix of the word before it, and
> capitalising it renders "GameS"

The guard existed. It just could not see either shape:

- `isPluralOrUnitExpression` requires EVERY branch to be a bare fragment, and
  `' is'` / `'s are'` each carry a word after the suffix, so the whole string
  was cased;
- the unit-suffix guard only fires on a span that begins with a LETTER, and a
  possessive span begins with an apostrophe. `titleCaseText("dan's table")` was
  always correct — "dan's" is one token — but a template hole splits the name
  from its `'s`, and the orphaned `s` was then cased on its own.

## The fix

Two rules, both narrow:

- a lone `s` immediately after an apostrophe is a possessive, never a word.
  O'Brien is unaffected, because the token there is "brien";
- a conditional branch may OPEN with a suffix and still be a sentence.
  `titleCaseBranch` protects a leading fragment and cases the rest — but only
  when the fragment is in the existing `PLURAL_OR_UNIT_FRAGMENTS` set, not
  merely because it is short. "go now" and "in play" open with real words and
  must still become "Go Now" and "In Play".

Verified the way that matters: after the fix, `--fix` makes **zero** changes.
The gate now agrees the corrected copy is correct, so it cannot re-break it on
the next run.

## The script is importable now

Everything above `const offenders` is a pure function; everything below is the
run. Importing the module used to execute the whole scan, so a unit test that
wanted to assert `titleCaseText` crashed on `readdirSync` before reaching a
single expectation. The run is now behind a "was I executed?" guard.

That is why these rules have real tests rather than a source pin —
`tests/unit/titleCaseSuffixesAreNotWords.test.ts` asserts the two strings that
actually shipped, including that the rendered output does not contain "GameS"
or "'S".

## Verification

`npx tsc --noEmit` clean. Full client suite: **758 files, 10,613 passed, 1
skipped, 0 failed.**
