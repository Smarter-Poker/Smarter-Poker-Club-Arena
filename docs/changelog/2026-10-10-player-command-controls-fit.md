# Player Command Controls Fit Their Page

## Cause And Repair

At a 1449px desktop viewport, the application provided a 1352px roster page, but `ClubMembersPage.css:21` computed its shared surface width from the viewport and selected 1380px. The page clips horizontal overflow, hiding the search and Export edges while document width still equals scroll width. At a 375px phone viewport, the same viewport-based mobile rule selected a 357px surface inside a 343px page.

The shared width now uses the actual containing block: `min(1380px, calc(100% - 32px))` on desktop and `calc(100% - 18px)` on phones. The page maximum is likewise its parent width. Every existing consumer (hero, console, selection bar, directory and count) inherits the correction. Approved artwork, controls, labels, permissions and behavior are unchanged; no global box-sizing rule was added.

## Regression Protection

The maintained CSS browser regression renders the actual production stylesheet inside a narrowed application shell at 1449px, 375px and 393px. It checks surfaces, search, sort, columns, selection, Refresh, Export and row controls against the actual page and console boxes, plus control content width. All three widths failed before repair despite zero document overflow; all three passed after repair. The existing production roster browser specification checks the same real page/control boundaries at these widths, including permission-specific controls whenever the viewer can see them.

Root owns the existing required CSS workflow registration, final candidate checks, protected delivery and published-page verification. Local rendered stylesheet proof is not publication proof.
