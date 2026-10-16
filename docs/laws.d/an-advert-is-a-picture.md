# tests/an-advert-is-a-picture.law.test.ts

Dan 2026-09-13: ads everywhere inside smarter.poker are responsive fluid images
only, and a tap opens the advert as a full-screen popup that then directs the
player where it points. Pins that no text-card ad component exists, that every
Club Arena surface mounts the one rotator, that the rotator renders a contained
image in a fixed-shape box and nothing else, that `fn_resolve_ads` refuses to
serve a placement with no picture (the standard lives in the resolver, not the
renderer), that all six house campaigns ship all four creative shapes, and that
a tap opens the interstitial without logging, the popup's button is the only
place a click becomes a click, closing is a dismiss, and the rotation holds
while the popup is open.

Owner-authored club banners use the same rotator and popup; only the exact club storage namespace is admitted alongside same-origin campaign art. Club banners never create paid campaign events.
