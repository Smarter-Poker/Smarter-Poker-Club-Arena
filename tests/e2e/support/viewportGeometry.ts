type VerticalBox = Readonly<{
  y: number;
  height: number;
}>;

export function footerOverlapScroll(
  controlBox: VerticalBox,
  footerBox: VerticalBox,
  clearance = 8
): number {
  return Math.max(0, controlBox.y + controlBox.height - (footerBox.y - clearance));
}
