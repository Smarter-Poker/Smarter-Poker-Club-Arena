# Post-deploy chooser font readiness

The isolated Find Your Game fixture loaded Google Fonts even though production self-hosts its fonts. It also awaited font readiness before concurrent React rendering mounted the labels. This allowed geometry checks to measure a fallback font.

Load the actual published Roboto Condensed 800 Latin face into the isolated document and require its successful load after the buttons mount. Keep the production CSS, artwork, viewport sizes, click assertions and original text bounds unchanged. Failed font requests or missing faces remain failures.

Validation: the controlled old fixture with unavailable Google Fonts fails both existing 375px and 393px iPhone WebKit bounds checks. The corrected fixture passes both. This changes verification only; it does not change production UI or financial behavior.
