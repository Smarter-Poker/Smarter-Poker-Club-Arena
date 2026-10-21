const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const OUTPUT_EDGE = 512;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be optimized.'))),
      'image/webp',
      quality
    );
  });
}

/** Keep the ordinary image decoder available in browsers without bitmap decoding. */
async function decodeLogo(file: File): Promise<{
  image: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // A bitmap decode failure does not mean the browser's image decoder fails.
    }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('That file is not a valid image.'));
      image.src = url;
    });
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => {
        image.src = '';
      },
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decode, center-crop, resize, and compress a user-controlled club logo. */
export async function optimizeClubLogo(file: File): Promise<string> {
  if (!ACCEPTED_TYPES.has(file.type)) {
    throw new Error('Choose a PNG, JPG, or WEBP image.');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('The source image must be 5MB or smaller.');
  }

  const decoded = await decodeLogo(file);
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_EDGE;
  canvas.height = OUTPUT_EDGE;
  try {
    if (!decoded.width || !decoded.height) {
      throw new Error('That image has invalid dimensions.');
    }
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) {
      throw new Error('Image optimization is unavailable in this browser.');
    }
    const sourceEdge = Math.min(decoded.width, decoded.height);
    context.drawImage(
      decoded.image,
      (decoded.width - sourceEdge) / 2,
      (decoded.height - sourceEdge) / 2,
      sourceEdge,
      sourceEdge,
      0,
      0,
      OUTPUT_EDGE,
      OUTPUT_EDGE
    );
  } finally {
    decoded.release();
  }

  let output = await canvasBlob(canvas, 0.88);
  if (output.size > MAX_OUTPUT_BYTES) output = await canvasBlob(canvas, 0.72);
  if (output.size > MAX_OUTPUT_BYTES) {
    throw new Error('The optimized logo is still too large. Try a simpler image.');
  }
  return blobToDataUrl(output);
}
