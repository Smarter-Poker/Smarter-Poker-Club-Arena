# Table Header Size And Placement

The action header and Lobby control now share a 52px control height at every viewport width. The previous phone-only correction stopped at 480px and removed vertical padding, leaving wider table views with 36px tabs and a 40px Lobby control. Shared source dimensions now place the controls 16px below the already-owned safe area/ticker/header boundary, with 8px below. The felt reserve derives from the same dimensions, including the appropriate separator borders. Lobby and session tracker follow the same alignment.

Existing artwork, navigation handlers, card previews, tab scrolling and safe-area ownership remain intact. Game/stakes text is larger. The existing required CSS Beat browser cases now cover browser and installed layouts at 320, 375, 393, 430, 480, 481, 606, 768 and 1280px with 0/24/59px insets, control clicks, pinned alignment, four tabs plus tracker and exact rendered/static reserve agreement. The new size/placement assertion fails against the prior source at the screenshot width.

Local validation: 108 Chromium/WebKit browser cases, 105 focused source/unit checks, TypeScript and four copy gates pass. Protected merge, publisher and live proof are recorded in CHECKPOINT-table-header-size.md.
