export function fuzzyMatch(pattern: string, target: string): boolean {
  if (!pattern) return true;
  pattern = pattern.toLowerCase();
  target = target.toLowerCase();

  let pIdx = 0;
  for (let tIdx = 0; tIdx < target.length; tIdx++) {
    if (target[tIdx] === pattern[pIdx]) {
      pIdx++;
      if (pIdx === pattern.length) return true;
    }
  }
  return false;
}
