# The house Title Case was ASCII-only, and it cut accented names in half

2026-09-13. Phase 3 of the ticker programme, which set out to translate the rail
and found there was nothing to translate into - and a live casing bug instead.

## What Phase 3 was going to be, and why it isn't

The phase was scoped as "the rail speaks English at everybody: twelve locales
ship and 417 files go through the translation layer". **Both numbers were
wrong.** Measured properly:

|                                         |                                    |
| --------------------------------------- | ---------------------------------- |
| files importing `src/i18n`              | **0**                              |
| calls to `setLocale` / `registerLocale` | **0**                              |
| locale files on disk                    | **0** (only the built-in `en` map) |
| surfaces offering a language picker     | **0**                              |

The 417 came from grepping `t\('`, which also matches `.at(`, `import(` and
`sort(` - it matched nearly every TypeScript file in the repo. The twelve came
from reading a type union.

`src/i18n/index.ts` is a complete, unwired module. Translating the rail would
have made it the only translated surface in Club Arena, consuming a framework
nothing else touches, with no way for a player to choose a language and nothing
to load if they could. That is ceremony, not a fix.

The module now carries that measurement at the top of the file, where the next
person reaching for it will see it, because a file this complete does not look
like a file nobody calls.

## What was actually broken

Both halves of the house casing rule matched on ASCII character classes.

`titleCase` did not skip an accented word politely. It matched the ASCII RUN
INSIDE the word and capitalised that:

```
"événement du soir"  ->  "éVéNement Du Soir"
"año nuevo"          ->  "AñO Nuevo"
"ırmak kulübü"       ->  "ıRmak KulüBü"
"über montag"        ->  "üBer Montag"
```

`formatPopupText` was less violent and still wrong - `[a-z]` simply is not a
word boundary class for most of the world, so the first word was never
capitalised at all:

```
"über montag"   ->  "über Montag"
"ırmak kulübü"  ->  "ırmak Kulübü"
```

Operators type club names, tournament names and custom ticker messages, and
every one of those strings passes through one of these two functions on its way
to a player. This is not an internationalisation feature. It is the house style
failing on names the platform already accepts and stores.

Both now use `\p{L}` / `\p{N}` / `\p{Ll}` with the `u` flag. ASCII is a subset,
so nothing English changes - 386 assertions across the 21 test files that touch
either transform still pass unmodified.

## Two subtleties worth keeping

**The acronym lookup stays invariant.** `titleCase` folds a word to lower case
to test it against the acronym set, and a locale-aware fold breaks that:
`"VIP".toLocaleLowerCase('tr')` is `"vıp"`, which is not in the set, and the
badge would silently stop shouting on a Turkish runtime. Only the DISPLAY
casing is locale-aware; the lookups are not.

**What this does not claim.** `toLocaleUpperCase` follows the RUNTIME locale, so
a Turkish player now sees "İzmir" where they used to see "Izmir" - but a Turkish
club name read by an English browser still gets the invariant answer. Fixing
that needs the language OF THE TEXT, which nothing on this platform records.
The honest guarantee is: right for the player whose own language it is, and
never worse for anybody else. The test says so out loud.

## Verified

- `tsc --noEmit` clean; eslint 0 errors on all three touched files
- `check:title-case` and `check:painted-text` both OK
- **386 assertions across all 21 test files that touch either transform** -
  the real blast radius - plus 9 new ones pinning the exact mangled strings
- Shard 1 of the full suite: 5,618 passed. Shards 2-4 could not be completed
  locally in this session - the host terminal killed every run over about a
  minute - so the full sharded gate on the pull request is the authoritative
  one. Nothing in this change is ticker-specific; if it regresses anything it
  will be in those 21 files, and they are green.
