# 2026-09-14: console wave 7c, the banner ink pass and the front door

A banner is not a card. `TableConnectionBanner` was a drawn pill with a 1px
orange rim over the felt, `HandForHandBanner` a 12px-radius card with two
gradients and an amber rim, `PushEnableBanner` a card with a filled teal button
(teal is not in the schema at all). All three are inked now: brand inks through
`sc-ink--*`, engraved rules, no radius, no gradient, no drawn control, and
their animations moved onto the mechanisms that replaced their carriers rather
than being dropped - `hfh-pulse-anim` now animates the bullet, `hfh-burst-flash`
animates opacity, and a reduced-motion block stops movement without stopping
meaning.

`AuthPage` - the first thing a new player sees - is on the console: eyebrow,
title, the mode in the painted pill, fields as grooves cut into the glass, tabs
as lit words, the two actions on the plates (and the password-update mode on a
flat cap with a lit word, so no painted plate is ever left empty). Paint only:
every handler, the getUser redirect, the `PASSWORD_RECOVERY` subscription, the
`authError` query handling, the return path, the age gate, the profile upserts
and the referral redemption are unchanged.

Defects found beyond the paint: the sign-in page printed the six literal
characters `✓` to the player, because an escape written as JSX text is
text; fourteen player-facing messages were in sentence case, all of them inside
`setError(...)` rather than JSX, which is why the copy gates never saw them;
and three more arrive from data and now go through `titleCase()` at the print
site.

Skipped as finished work: the NLH premium lobby cards and the layered card
family are wholly on approved master art with a visual contract naming them,
and `PreviousHandCard` is one of three interchangeable 66px HUD tiles whose
face is an approved button asset and whose geometry is pinned as a set.

One test was narrowed, not weakened: the reconnecting-banner law matched
`/\bt op:\s*\d+px/` without the word boundary behaving as intended - `\b` sits
between the hyphen and the `t` of `border-top`, so the pin read an engraved
rule as a pixel position. It is `(?<![\w-])top:` now, and the 2026-08-30 bug it
was written for is still caught (verified by reintroducing it).
