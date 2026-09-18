# Diamond Scene Rendering Backpressure

The hosted 320px playfield check exhausted its unchanged 90-second limit while
Plinko continuously submitted frames: opening Plinko took about 26 seconds and
the denomination click another 33 seconds. The same actual component fixture
completed on the local Mac, so the hosted timing failure was not reproduced
locally. The trace and its failing run remain retained with the task evidence.

Plinko, Crash and Crossing now keep at most one unfinished scene frame in the GPU
queue. A zero-timeout WebGL fence query yields to input while the previous frame
is busy. Animation clocks, confirmed results, geometry, materials, lighting and
shadows are unchanged; the next available frame renders the latest state. Context
loss discards invalid fences and unmount disposes outstanding fences and listeners.
Plinko and Crash also release their existing shadow texture during scene cleanup.

The maintained unit path checks busy/ready transitions, latest state, disposal and
context restoration. The existing browser classifier covers the shared renderer
and scene callers, and the unchanged three-viewport real-component browser cases
remain the required hosted acceptance. A local SwiftShader comparison showed
safe-crossing input falling from 438ms to 36ms and collision input from 138ms to
32ms; initial shader compilation still takes seconds. Local evidence does not
replace the required hosted run or production publication proof.
