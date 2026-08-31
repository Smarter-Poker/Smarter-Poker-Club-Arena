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

/** Decode, center-crop, resize, and compress a user-controlled club logo. */
export async function optimizeClubLogo(file: File): Promise<string> {
  if (!ACCEPTED_TYPES.has(file.type)) {
    throw new Error('Choose a PNG, JPG, or WEBP image.');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('The source image must be 5MB or smaller.');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file is not a valid image.');
  }
  if (!bitmap.width || !bitmap.height) {
    bitmap.close();
    throw new Error('That image has invalid dimensions.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_EDGE;
  canvas.height = OUTPUT_EDGE;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) {
    bitmap.close();
    throw new Error('Image optimization is unavailable in this browser.');
  }

  const sourceEdge = Math.min(bitmap.width, bitmap.height);
  const sourceX = (bitmap.width - sourceEdge) / 2;
  const sourceY = (bitmap.height - sourceEdge) / 2;
  context.drawImage(
    bitmap,
    sourceX,
    sourceY,
    sourceEdge,
    sourceEdge,
    0,
    0,
    OUTPUT_EDGE,
    OUTPUT_EDGE
  );
  bitmap.close();

  let output = await canvasBlob(canvas, 0.88);
  if (output.size > MAX_OUTPUT_BYTES) output = await canvasBlob(canvas, 0.72);
  if (output.size > MAX_OUTPUT_BYTES) {
    throw new Error('The optimized logo is still too large. Try a simpler image.');
  }
  return blobToDataUrl(output);
}
