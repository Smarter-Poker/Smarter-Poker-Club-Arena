import * as THREE from 'three';

/** Same spheres, materials and shadows; one batch for each lighting state. */
export function plinkoPegField(steel: THREE.MeshPhysicalMaterial) {
  const group = new THREE.Group();
  const geometry = new THREE.SphereGeometry(0.105, 14, 10);
  const bright = steel.clone();
  bright.emissive.setHex(0x1877f2);
  bright.emissiveIntensity = 1.3;
  const unlit = new THREE.InstancedMesh(geometry, steel, 136);
  const lit = new THREE.InstancedMesh(geometry, bright, 16);
  unlit.castShadow = lit.castShadow = true;
  lit.count = 0;
  group.add(unlit, lit);
  const positions: THREE.Matrix4[] = [];
  for (let row = 0; row < 16; row++) {
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
  return {
    group,
    reveal(path: number[], throughRow: number) {
      const key = `${throughRow}:${path.join('')}`;
      if (last === key) return;
      last = key;
      positions.forEach((matrix, index) => unlit.setMatrixAt(index, matrix));
      lit.count = Math.max(0, Math.min(16, throughRow + 1));
      let rights = 0;
      for (let row = 0; row < lit.count; row++) {
        const index = (row * (row + 1)) / 2 + rights;
        lit.setMatrixAt(row, positions[index]);
        unlit.setMatrixAt(index, hidden);
        rights += path[row] ?? 0;
      }
      unlit.instanceMatrix.needsUpdate = lit.instanceMatrix.needsUpdate = true;
      unlit.computeBoundingSphere();
      lit.computeBoundingSphere();
    },
    dispose() {
      unlit.dispose();
      lit.dispose();
    },
  };
}
