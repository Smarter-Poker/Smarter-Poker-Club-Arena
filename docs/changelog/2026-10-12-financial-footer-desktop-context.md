# Financial footer desktop context

The 1280px Register browser case inherited the iPhone emulation context and
changed only its viewport. The hosted trace showed an initially reachable
target followed by mobile visual-viewport scrolling under the fixed footer.
The desktop case now uses a desktop context; 375px and 393px remain mobile.
All three footer heights, hit-target checks, clearance, unforced clicks and
embedded height assertions are retained. All three focused viewport cases
passed locally in Chromium. The original case also passed once locally; the
hosted failure trace remains the failure evidence. Product CSS and financial
SQL are unchanged.
