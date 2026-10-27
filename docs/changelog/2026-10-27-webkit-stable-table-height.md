# WebKit table height uses the same scale as its desktop layout

A 320x568 WebKit phone was laid out at the approved 600px desktop width and 1065px height, while 100svh still measured 568px. The felt used that stale-scale height and became short enough for player plates and actions to overlap the board.

Capture the stable small viewport before changing its meta scale, normalize that one dimension into the desktop layout, and share it across mounted tables. Detect whether the browser's stable units already follow layout scaling so other browsers are not scaled twice. Genuine viewport changes update the stable dimension; browser-bar and hand events cannot rescale the felt. Restore the original viewport and remove the owned height on the last table's exit. Preserve the 600px desktop parity, artwork, 95% board, seat rings, all animations, user controls, independent horse reads and game APIs.

The owner hook regression reproduces missing height, and covers table switching, final cleanup, actual viewport resize, browsers with already-scaled units, desktop and unsupported-unit fallback. Browser development and production proof remain separate; the full mobile containment case still requires board-edge avatar clearance and is not described as passed from the height fix alone.
