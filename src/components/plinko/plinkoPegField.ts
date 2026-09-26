import * as THREE from 'three';

/** The pegs are laid out as a triangle, one more peg on every row down. */
export const PEG_ROWS = 16;
/** A row holds one lit instance per ball that can be on it, capped by the batch. */
export const LIT_PEGS = 16;
/** Every peg on the board: 1 + 2 + ... + 16. */
export const PEG_COUNT = (PEG_ROWS * (PEG_ROWS + 1)) / 2;
/** Where a peg's face sits on the board, in the scene's own units. */
export const PEG_Z = 0.15;

/** The centre of the peg at `col` on `row`, the one layout every peg layer shares. */
export function pegCentre(row: number, col: number): [x: number, y: number] {
  return [(col - row / 2) * 0.65, 4.7 - row * 0.55];
}

/**
 * A machined chrome stud: a short stem into the glass, a bevelled shoulder and a
 * domed face, turned on a lathe and stood facing the player so the specular
 * highlight sits on the dome. About two hundred triangles a peg, drawn instanced.
 */
export function pegStudGeometry() {
  const profile = [
    [0.05, -0.17],
    [0.05, -0.03],
    [0.116, -0.01],
    [0.118, 0.03],
    [0.104, 0.075],
    [0.078, 0.108],
    [0.042, 0.126],
    [0, 0.13],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const geometry = new THREE.LatheGeometry(profile, 18);
  // The lathe turns about y; the stud faces the camera down +z.
  geometry.rotateX(Math.PI / 2);
  geometry.name = 'Plinko Chrome Stud';
  return geometry;
}

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

/** Same studs, materials and shadows; one batch for each lighting state. */
export function plinkoPegField(steel: THREE.MeshPhysicalMaterial) {
  const group = new THREE.Group();
  const geometry = pegStudGeometry();
  const bright = steel.clone();
  bright.emissive.setHex(0x45adff);
  bright.emissiveIntensity = 1.5;
  const unlit = new THREE.InstancedMesh(geometry, steel, PEG_COUNT);
  const lit = new THREE.InstancedMesh(geometry, bright, LIT_PEGS);
  unlit.castShadow = lit.castShadow = true;
  lit.count = 0;
  group.add(unlit, lit);
  const positions: THREE.Matrix4[] = [];
  for (let row = 0; row < PEG_ROWS; row++) {
    for (let col = 0; col <= row; col++) {
      const [x, y] = pegCentre(row, col);
      const matrix = new THREE.Matrix4().makeTranslation(x, y, PEG_Z);
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
      geometry.dispose();
    },
  };
}
