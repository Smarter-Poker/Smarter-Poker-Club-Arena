# Table Text Always Shows The Full Wording

The tournament felt description shared a single line with a nonshrinking hand number. Its hidden overflow and ellipsis shortened the buy-in label to “FR...”. Captions now wrap within their existing width, and the tournament hand number sits on its own line. Club and union names can also wrap at phone breakpoints. Player names no longer lose everything after character eleven; names, winning-hand descriptions, pot amounts and the spectator caption wrap instead of clipping.

This client presentation change uses existing data and engine APIs. It requires no engine replacement. The October 26 owner instruction supersedes older character budgets and single-line caption rules. Existing artwork, typography, financial values and game behavior are preserved.

Regression protection: tests/table-captions-show-every-word.law.test.ts and the rendered table caption checks. Delivery evidence remains in the task checkpoint under /Volumes/SmarterArchives/agent-evidence/table-full-labels-20261026/.

Follow-up review also removed speech/add-on bubble line clamps and sender ellipses. Bubbles can use the available pane width and move vertically within the pane to retain all words in narrow multi-table and short landscape layouts. Message lifetimes, voice animation and pointer-event behavior are preserved. Fifteen browser cases include actual ChatBubble rendering with 200-character messages and long sender names.
