# Record the riveted rail's measured artwork

PR4573 added the 729x8 riveted console rail without its measured matte
baseline. The next required CI run failed because the detector reads 1.5%
on its silver side rails. Operational case37716 retains the failed job
103851753878 and source provenance.

Opening the shipped strip and examining the detector's exact pixel mask
shows 88 opaque pixels in 11 complete columns: x54-56,60-61 and664-669.
These are the visible brushed grey rails. Removing them would make holes
through every repeated row. A second in-memory pass reaches0%, demonstrating
why numerical convergence alone cannot establish that a removal is correct.
No artwork file was changed. Its SHA256 remains
3a167b0f63161ba133e795184233c6c281609e96b70a5e1aa0b02adce1e73d50.

Record only this measured1.5% value using the existing calibration mechanism.
The detector and global threshold stay intact. The regression check decodes
the actual rail, accepts its measured reading, then adds a white strip to a
private buffer and requires the same gate to refuse the increase. Existing
asset readings and all other calibrated entries remain covered.
