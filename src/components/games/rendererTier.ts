/**
 * True when WebGL is being drawn by the CPU (SwiftShader, llvmpipe, Mesa's
 * software rasteriser, Microsoft's Basic Render Driver). Every pixel and every
 * shadow tap costs main-thread-adjacent CPU there, so a scene should draw at
 * device pixel ratio 1 and skip shadow maps: the picture keeps every element,
 * only its resolution and its shadows change. A renderer that will not say
 * what it is counts as hardware.
 */
export function isSoftwareRenderer(
  context: WebGLRenderingContext | WebGL2RenderingContext | null | undefined
): boolean {
  try {
    if (!context || typeof context.getParameter !== 'function') return false;
    const info = context.getExtension('WEBGL_debug_renderer_info');
    const name = String(
      (info && context.getParameter(info.UNMASKED_RENDERER_WEBGL)) ||
        context.getParameter(context.RENDERER) ||
        ''
    );
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}
