# tests/diamond-arena-is-the-light-room.law.test.ts

Dan, 2026-09-11: "ONLY DIFFERENCE BETWEEN THEM IS DIAMOND ARENA SHOULD BE WHITE, OR LIGHT SCHEMA, CLUB ARENA DARK."

`<html>` already carried two theme attributes that had to be prised apart after they served the wrong palette on production for weeks: `data-theme` is the player's interface mode, `data-color-theme` is the table felt. The conclusion of that postmortem was that one attribute with two meanings is decided by whichever writer ran last.

So the arena scheme is a THIRD attribute rather than a fourth writer on an existing one. It answers where the player IS; the other two answer what the player PREFERS and what the felt looks like.

This law holds the three apart, holds the room's paint off the table (the seat-plate token list is enforced here too, because that law reads `design-tokens.css` and this scheme is declared in the globally loaded sheet it cannot see), and keeps one declaration per room so the two grounds cannot drift.
