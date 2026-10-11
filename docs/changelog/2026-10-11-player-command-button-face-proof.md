# Player Command Button Face Proof

The published Vault body portal resolves the footer overlap. Final live verification also identified a sampling error in the new production assertion: the 3-by-3 rectangle grid sampled two pixels inside rounded corners, where the button intentionally has no face. At 375px the real Cancel button has a 10px radius; the lower-centre point correctly reaches Cancel, while corner voids reach the action container.

The maintained production case now samples nine points on the button face: centre, each straight edge two pixels inside, and four inner quadrants. The bottom-centre point that demonstrated the original 11.6px footer overlap is retained exactly, as are top/left/right edge checks. No radius, colour, layout, dialog, transaction or runtime source changes are made to satisfy the test.

Fresh exact published 99364a9b at 375px passes the corrected nine-point check for Help and Cancel, preserves initial focus and exact Buy opener restoration. The original 375px baseline lower-centre hit reached Players; the corrected assertion retains that same coordinate. A later retained baseline tab was desktop-sized and is not counted as a new mobile reproduction. Root retains remaining 393px/native focus/production-case verification and protected test-only integration. Compiler and six-case discovery are checked before submission.
