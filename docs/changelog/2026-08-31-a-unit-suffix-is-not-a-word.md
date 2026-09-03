# A Unit Suffix Is Not A Word

**2026-08-31**

`check-title-case` capitalises the first letter of every word. A letter sitting
immediately after a digit is not the first letter of a word - it is the tail of
the token the digits started.

```
Last 24h        ->  Last 24H
Win 1.5x        ->  Win 1.5X
Won 20bb+ Pots  ->  Won 20BB+ Pots
GPT-4o Mini     ->  GPT-4O Mini
```

## Why This Is Worse Than A Cosmetic Bug

The gate is also the fixer. Once `--fix` writes "24H", the gate **demands**
"24H" from then on: the corruption is what passes CI, and the correct copy is
what fails it. A rule that enforces its own mistake is not something review
catches.

## How It Was Found

By running this gate against the apex site on 2026-08-31, where the same logic
wanted to rewrite `Last 24h`, `Signups (7d)`, `Won 20bb+ Pots` and `GPT-4o Mini`
on live admin pages - 43 rewrites, every one of them a letter immediately
preceded by a digit, and every one of them wrong.

The World Hub copy of this gate already carries the guard. Club Arena's did not.
This brings the two back into agreement, which matters more than the bug: two
gates enforcing "the same" rule by different logic is how two codebases drift
apart while both report OK.

Club Arena's own attempt at this guard - `if (/^[0-9]/.test(word))` - can never
fire, because the match expression begins at `[A-Za-z]`, so `word` never starts
with a digit. It is left in place because a future edit to that regex would make
it load-bearing again.

## Scope

Nothing in Club Arena's copy hits this today - running `--fix` with the guard in
place changes zero files. That is exactly what makes it worth pinning rather
than leaving: it is a trap set for whoever next writes "24h" on a page.

`tests/a-unit-suffix-is-not-a-word.law.test.ts` pins both directions - the seven
suffix forms are left alone, and ordinary words, acronyms, interior capitals and
HTML entities still behave.
