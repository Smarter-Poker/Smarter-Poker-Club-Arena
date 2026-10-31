export interface CardBox {
  left: number;
  top: number;
  width: number;
  height: number;
}
const intersects = (a: CardBox, b: CardBox, gap: number) =>
  a.left < b.left + b.width + gap &&
  a.left + a.width + gap > b.left &&
  a.top < b.top + b.height + gap &&
  a.top + a.height + gap > b.top;

/** Nearest clear position, preserving the row size and the association with its seat. */
export function placeProtectedCardRow(
  row: CardBox,
  protectedBoxes: CardBox[],
  bounds: CardBox,
  gap = 4,
  accept: (box: CardBox) => boolean = () => true
) {
  const xs = [row.left, bounds.left, bounds.left + bounds.width - row.width];
  const ys = [row.top, bounds.top, bounds.top + bounds.height - row.height];
  for (const box of protectedBoxes) {
    xs.push(box.left - row.width - gap, box.left + box.width + gap);
    ys.push(box.top - row.height - gap, box.top + box.height + gap);
  }
  const fits = (box: CardBox) =>
    box.left >= bounds.left &&
    box.top >= bounds.top &&
    box.left + box.width <= bounds.left + bounds.width &&
    box.top + box.height <= bounds.top + bounds.height &&
    protectedBoxes.every((other) => !intersects(box, other, gap)) &&
    accept(box);
  if (fits(row)) return row;
  let best: CardBox | null = null;
  let distance = Infinity;
  for (const left of new Set(xs)) {
    for (const top of new Set(ys)) {
      const nextDistance = Math.hypot(left - row.left, top - row.top);
      if (nextDistance >= distance) continue;
      const candidate = { left, top, width: row.width, height: row.height };
      if (fits(candidate)) {
        best = candidate;
        distance = nextDistance;
      }
    }
  }
  return best;
}
