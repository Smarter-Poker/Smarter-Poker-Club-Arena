import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { gpuFrameRenderer } from '../../src/components/games/gpuFrameRenderer';

function fixture() {
  const canvas = document.createElement('canvas');
  const gl = {
    TIMEOUT_EXPIRED: 0x911b,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    clientWaitSync: vi.fn(() => 0x911a),
    fenceSync: vi.fn(() => ({}) as WebGLSync),
    deleteSync: vi.fn(),
    flush: vi.fn(),
    isContextLost: vi.fn(() => false),
  };
  const renderer = {
    getContext: () => gl as unknown as WebGL2RenderingContext,
    domElement: canvas,
    render: vi.fn(),
  };
  const scene = new THREE.Scene();
  const frames = gpuFrameRenderer(renderer, scene, new THREE.PerspectiveCamera());
  return { canvas, gl, renderer, scene, frames };
}

describe('game GPU frame backpressure', () => {
  it('does not submit another frame while the GPU is busy, then draws the latest state', () => {
    const { gl, renderer, scene, frames } = fixture();
    expect(frames.render()).toBe(true);
    const fence = gl.fenceSync.mock.results[0].value;
    gl.clientWaitSync.mockReturnValue(gl.TIMEOUT_EXPIRED);
    for (let i = 0; i < 100; i++) expect(frames.render()).toBe(false);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(gl.fenceSync).toHaveBeenCalledTimes(1);
    expect(gl.clientWaitSync).toHaveBeenLastCalledWith(fence, 0, 0);
    scene.position.x = 16;
    gl.clientWaitSync.mockReturnValue(0x911c);
    expect(frames.render()).toBe(true);
    expect(renderer.render.mock.calls.at(-1)?.[0].position.x).toBe(16);
    expect(gl.deleteSync).toHaveBeenCalledWith(fence);
    expect(gl.flush).toHaveBeenCalledTimes(2);
    frames.dispose();
    expect(gl.deleteSync).toHaveBeenCalledTimes(2);
    expect(frames.render()).toBe(false);
  });

  it('discards a lost context fence and resumes with the restored context', () => {
    const { canvas, gl, frames } = fixture();
    frames.render();
    gl.isContextLost.mockReturnValue(true);
    canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(frames.render()).toBe(false);
    gl.isContextLost.mockReturnValue(false);
    expect(frames.render()).toBe(true);
    expect(gl.clientWaitSync).not.toHaveBeenCalled();
    expect(gl.deleteSync).not.toHaveBeenCalled();
    frames.dispose();
    expect(gl.deleteSync).toHaveBeenCalledTimes(1);
  });

  it('keeps rendering on older contexts without WebGL2 fence support', () => {
    const renderer = {
      getContext: () => ({ isContextLost: () => false }) as WebGLRenderingContext,
      domElement: document.createElement('canvas'),
      render: vi.fn(),
    };
    const frames = gpuFrameRenderer(renderer, new THREE.Scene(), new THREE.PerspectiveCamera());
    expect(frames.render()).toBe(true);
    expect(frames.render()).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    frames.dispose();
    expect(frames.render()).toBe(false);
  });
});
