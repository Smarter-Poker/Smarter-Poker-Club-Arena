import type * as THREE from 'three';

/** Keep at most one unfinished scene frame in the GPU queue. A slow graphics
 * device must not make touch input wait behind an ever-growing render backlog.
 * The caller still advances its animation clock and submits its latest state. */
export function gpuFrameRenderer(
  renderer: Pick<THREE.WebGLRenderer, 'getContext' | 'domElement' | 'render'>,
  scene: THREE.Scene,
  camera: THREE.Camera
) {
  const context = renderer.getContext();
  // Three also supports older WebGL contexts. Keep their existing renderer;
  // only WebGL2 exposes the non-blocking completion fence.
  const gl = 'fenceSync' in context ? context : null;
  let fence: WebGLSync | null = null;
  let disposed = false;
  const release = () => {
    if (fence) gl?.deleteSync(fence);
    fence = null;
  };
  const lost = () => {
    // Context loss invalidates its objects; a restored context gets a fresh fence.
    fence = null;
  };
  renderer.domElement.addEventListener('webglcontextlost', lost);
  return {
    render() {
      if (disposed || context.isContextLost()) return false;
      if (gl && fence) {
        // Zero timeout is essential: this is a readiness query, never a CPU wait.
        if (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) return false;
        release();
      }
      renderer.render(scene, camera);
      if (gl) {
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
      }
      return true;
    },
    dispose() {
      disposed = true;
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      release();
    },
  };
}
