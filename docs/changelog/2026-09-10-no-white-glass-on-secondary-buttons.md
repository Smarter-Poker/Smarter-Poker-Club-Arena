# No white glass on secondary buttons

Dan, 2026-09-10, pointing at the Poker Arena / Choose Arena nav on the club
lobby: "remove the shitty white background on the button ... if any other
buttons have this shitty background edit they all need to be fixed now."

## What it was

`.btn-secondary` (and `.icon-btn-secondary`) in `src/components/common/Button.css`
were `background: rgba(255, 255, 255, 0.1)` with an 8px `backdrop-filter: blur`.
On the dark lobby that translucent white reads as a cheap grey box. Confirmed
on production, signed in, on a phone: the nav button's computed background was
exactly `rgba(255, 255, 255, 0.1)`, border `rgba(255, 255, 255, 0.15)`,
`backdrop-filter: blur(8px)`. Every secondary button shares the class, so the
same box was everywhere the class is used.

## What it is now

A bevelled gunmetal face: a dark vertical gradient (`#2c333d → #10141a`), a
steel hairline border with a lighter lit top edge, an inner top highlight and
inner bottom shadow, and a drop shadow. No white fill, no backdrop blur. On
`:active` it seats down and lights a thin blue edge, matching the metallic
console surfaces (#SmarterCasinoRealism). The nav button inherits this class,
so it is fixed by the same edit.

Also fixed: one stray unscoped `.btn-secondary` in the admin engine dashboard
that carried the same white fill for its disabled state; it is now a muted
dark fill.

## Scope

This is the shared secondary-button surface. Buttons inside dialogs already
gain a metal bevel from `metallic-popups.css`. A number of per-component
buttons (filters, close controls, tab pills) set their own translucent-white
tint at the component level; those are a follow-up sweep, tracked, and were
left out of this pass so the shared change could ship and be seen first.
