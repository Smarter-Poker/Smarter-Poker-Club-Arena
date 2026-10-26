# AI opponents are disclosed at sign-up and in the Terms

Dan, 2026-10-25: "ADD ONE LINE TO THE SIGN UP DISCLOSURES".

Players are now told once, before they play, that tables may include AI
opponents and that seats are not identified:

> Tables May Include AI Opponents Run By Smarter.Poker. They Play Under
> Ordinary Player Names, And We Do Not Say Which Seats They Hold.

Where it shows:

- the native sign-up form (`src/pages/AuthPage.tsx`, under the referral code);
- the Terms of Service page, as its own "AI Opponents" section;
- the Terms acceptance modal that gates Club Arena, as section 6 (later
  sections renumbered).

The sentence lives once, in `src/components/legal/aiOpponentsDisclosure.ts`.
Nothing at the table changes: horses still sit, play, earn and are paid
exactly like every other player (CLAUDE.md 10.5), and no seat is labelled.

The Terms date moves to October 25, 2026 and the legal-date fingerprints are
re-recorded in the same commit
(`tests/legal-dates-move-with-the-words.law.test.tsx`). The new law
`tests/ai-opponents-are-disclosed.law.test.tsx` keeps the sentence on all
three surfaces.

Players who accepted the earlier Terms are not re-prompted by this change;
the updated Terms page is posted under the existing "Changes To Terms" clause.
