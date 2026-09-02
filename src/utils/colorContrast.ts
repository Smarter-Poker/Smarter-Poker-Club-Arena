const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

export function relativeLuminance(color: string): number | null {
  if (!isHexColor(color)) return null;
  const red = channel(Number.parseInt(color.slice(1, 3), 16));
  const green = channel(Number.parseInt(color.slice(3, 5), 16));
  const blue = channel(Number.parseInt(color.slice(5, 7), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  if (first === null || second === null) return 0;
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
