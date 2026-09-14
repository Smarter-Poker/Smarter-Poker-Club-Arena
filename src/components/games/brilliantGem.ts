import * as THREE from 'three';

/** Faceted crown, girdle and pavilion, with hard face normals for distinct reflections. */
export function brilliantGem(radius = 0.48) {
  const rings = [
    { y: 0.58, r: 0.46 },
    { y: 0.19, r: 1 },
    { y: 0.12, r: 1 },
    { y: -0.7, r: 0.015 },
  ];
  const positions: number[] = [];
  const point = (ring: number, i: number) => {
    const angle = (i * Math.PI) / 8;
    return [
      Math.cos(angle) * rings[ring].r * radius,
      rings[ring].y * radius,
      Math.sin(angle) * rings[ring].r * radius,
    ];
  };
  for (let i = 0; i < 16; i++) {
    positions.push(0, rings[0].y * radius, 0, ...point(0, i + 1), ...point(0, i));
    for (let j = 0; j < rings.length - 1; j++) {
      positions.push(...point(j, i), ...point(j, i + 1), ...point(j + 1, i));
      positions.push(...point(j, i + 1), ...point(j + 1, i + 1), ...point(j + 1, i));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
