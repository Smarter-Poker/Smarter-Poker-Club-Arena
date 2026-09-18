# Plinko Keeps Its 3D Scene On Resize

The initial measured playfield width rebuilt the room environment, shaders and every GPU resource. Hosted software rendering exposed this as stalled touch controls and a 320px browser timeout. Resizing now updates the existing camera and canvas. The 136 physical pegs retain their geometry, materials, shadows and blue path lights in two instanced batches.

The real-component resource-lifetime regression fails against the previous source (two scene creations) and passes after the repair (one scene through resize and denomination changes). A real Three.js geometry case checks positions and path lighting. Both cases pass. Safe phone preview confirms the board and denomination selection. Required hosted browser verification remains authoritative; no timeout or assertion was relaxed for this repair. Local typecheck has only the existing missing native-package failures.
