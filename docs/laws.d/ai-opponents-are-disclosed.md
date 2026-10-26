# tests/ai-opponents-are-disclosed.law.test.tsx

Dan, 2026-10-25: add one line to the sign-up disclosures. Horses play under
ordinary player names and the table never says which seats they hold
(CLAUDE.md 10.5); players are told once, up front, that AI opponents may be
seated. The sentence lives in `src/components/legal/aiOpponentsDisclosure.ts`
and this law fails if the native sign-up form, the Terms of Service page or
the acceptance modal stops showing it.
