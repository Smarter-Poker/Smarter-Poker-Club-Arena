# 2026-09-03 - Mobile sort bar: the desktop heading row, framed

Dan: the mobile action bar "NEEDS THE SAME TYPE OF DYNAMIC UPGRADE ... THE
BACKGROUND SHOULD BE BLACK". First cut (chamfered steel chips) rejected -
"THOSE BUTTONS FEEL CHEAP AND NOT PREMIUM". He attached the desktop column
heading row as the reference; second cut approved with one correction, "THE
BORDER FRAME NEEDS TO BE THICKER AND MORE DEFINED".

- `LobbySortBar.css` (new): six equal cells in one black strip, hairline
  dividers, spaced grey capitals, live sort in blue with caret and a lit
  underline, all inside a 2px brushed-steel rim with a blue edge glow. Fits
  375px with no scrolling.
- `LobbyTable.css`: bar ground to #000, border-bottom removed; structure
  (display:none above 900px, flex, both overflow axes) unchanged - the file
  stays solid-colour under its pins, which is why the chrome lives in its own
  sheet.
- `LobbyTable.tsx`: label wrapped in `.lobby-sortbar__label`; imports the
  new sheet. Handlers, roving tabindex and the live region untouched.
