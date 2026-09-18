import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { plinkoPegField } from '../../src/components/plinko/plinkoPegField';

describe('the physical Plinko peg field', () => {
  it('retains all 136 positions with two shadow draws and lights the server path', () => {
    const field = plinkoPegField(new THREE.MeshPhysicalMaterial());
    const [unlit, lit] = field.group.children as THREE.InstancedMesh[];
    expect(field.group.children).toHaveLength(2);
    expect(unlit.count).toBe(136);
    expect(lit.count).toBe(0);
    expect(unlit.castShadow && lit.castShadow).toBe(true);
    const matrix = new THREE.Matrix4();
    unlit.getMatrixAt(135, matrix);
    expect(matrix.elements[12]).toBeCloseTo(4.875);
    expect(matrix.elements[13]).toBeCloseTo(-3.55);
    field.reveal([1, 0, 1], 2);
    expect(lit.count).toBe(3);
    lit.getMatrixAt(2, matrix);
    expect(matrix.elements[12]).toBeCloseTo(0);
    unlit.getMatrixAt(4, matrix);
    expect(matrix.determinant()).toBe(0);
    field.reveal([], -1);
    expect(lit.count).toBe(0);
    unlit.getMatrixAt(4, matrix);
    expect(matrix.determinant()).toBe(1);
    field.dispose();
  });
});
