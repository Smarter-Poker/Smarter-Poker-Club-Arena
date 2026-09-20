import * as THREE from 'three';

/** The pegs are laid out as a triangle, one more peg on every row down. */
export const PEG_ROWS = 16;
/** A row holds one lit instance per ball that can be on it, capped by the batch. */
export const LIT_PEGS = 16;

/** The instanced index of the peg a drop reaches on `row` after `rights` right turns. */
export function pegIndexAt(row: number, rights: number): number {
  return (row * (row + 1)) / 2 + rights;
}

/**
 * Every peg a sealed path strikes, from the top row down to `throughRow`. The
 * path is the server's own bits, one turn a row, so the lit trail is derived
 * from the same arithmetic as the ball's x position and can never disagree.
 */
export function struckPegIndices(path: number[], throughRow: number): number[] {
  const rows = Math.max(0, Math.min(PEG_ROWS, throughRow + 1));
  const struck: number[] = [];
  let rights = 0;
  for (let row = 0; row < rows; row++) {
    struck.push(pegIndexAt(row, rights));
    rights += path[row] ?? 0;
  }
  return struck;
}

/** Same spheres, materials and shadows; one batch for each lighting state. */
export function plinkoPegField(steel: THREE.MeshPhysicalMaterial) {
  const group = new THREE.Group();
  const geometry = new THREE.SphereGeometry(0.105, 14, 10);
  const bright = steel.clone();
  bright.emissive.setHex(0x1877f2);
  bright.emissiveIntensity = 1.3;
  const unlit = new THREE.InstancedMesh(geometry, steel, 136);
  const lit = new THREE.InstancedMesh(geometry, bright, LIT_PEGS);
  unlit.castShadow = lit.castShadow = true;
  lit.count = 0;
  group.add(unlit, lit);
  const positions: THREE.Matrix4[] = [];
  for (let row = 0; row < PEG_ROWS; row++) {
    for (let col = 0; col <= row; col++) {
      const matrix = new THREE.Matrix4().makeTranslation(
        (col - row / 2) * 0.65,
        4.7 - row * 0.55,
        0.15
      );
      unlit.setMatrixAt(positions.length, matrix);
      positions.push(matrix);
    }
  }
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  let last = '';
  /**
   * Light exactly these pegs. One drop hands over the trail it has struck; a
   * batch hands over the peg each ball is passing this frame, which is why this
   * takes a list rather than a single path. Redundant frames are skipped so the
   * instance matrices only upload when the set actually changes.
   */
  function light(indices: number[]) {
    const wanted: number[] = [];
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= positions.length) continue;
      if (wanted.includes(index)) continue;
      wanted.push(index);
      if (wanted.length === LIT_PEGS) break;
    }
    const key = wanted.join(',');
    if (last === key) return;
    last = key;
    positions.forEach((matrix, index) => unlit.setMatrixAt(index, matrix));
    lit.count = wanted.length;
    wanted.forEach((index, slot) => {
      lit.setMatrixAt(slot, positions[index]);
      unlit.setMatrixAt(index, hidden);
    });
    unlit.instanceMatrix.needsUpdate = lit.instanceMatrix.needsUpdate = true;
    unlit.computeBoundingSphere();
    lit.computeBoundingSphere();
  }
  return {
    group,
    light,
    reveal(path: number[], throughRow: number) {
      light(struckPegIndices(path, throughRow));
    },
    dispose() {
      unlit.dispose();
      lit.dispose();
    },
  };
}
