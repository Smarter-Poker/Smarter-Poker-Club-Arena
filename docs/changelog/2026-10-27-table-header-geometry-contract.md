# Table header geometry contract

The header size fix used minimum browser assertions that could miss an oversized control or a drifting Lobby/tracker. The existing required CSS Beat checks now pin independently expected control heights and top positions across all nine widths, short-phone exceptions, installed/browser safe areas, crowded tabs, pinned global headers and ticker ownership. Desktop sibling alignment includes its intentional half-pixel border offset.

This changes tests only. The approved live52px header and Lobby artwork, handlers, responsive clearance and engine remain unchanged. Local Chromium/WebKit132 cases pass; a6px pinned Lobby drift that passes the previous checks must fail the strengthened checks.

The header helper now lives in the existing shared support lane. The former css/helper-only path did not admit browser CI; a focused classifier regression pins both its new path and its owning spec as browser inputs. No new workflow or classifier logic is introduced.
