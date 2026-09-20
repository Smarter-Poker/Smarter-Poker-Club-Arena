/** One physical curve owns rotation, peg crossings and the landing sound. */
export const WHEEL_SPIN_MS = 10800;
export const WHEEL_TURNS = 7;

/** The pawl bends against each divider, then springs back into the prize bay. */
export function wheelPointerDeflection(rotation: number, count: number, direction: 1 | -1): number {
  if (!Number.isFinite(rotation) || count < 1) return 0;
  const step = 360 / count;
  const phase = ((((rotation * direction) % step) + step) % step) / step;
  if (phase > 0.86) {
    const contact = (phase - 0.86) / 0.14;
    return -direction * 26 * contact * contact;
  }
  if (phase < 0.35) {
    const release = phase / 0.35;
    return -direction * 26 * (1 - release) ** 3 * Math.cos((phase * Math.PI) / 0.12);
  }
  return 0;
}

// Continuous velocity: accelerate for 12%, coast for 25%, then slow to zero.
const ACCEL = 0.12;
const COAST_END = 0.37;
const DISTANCE = ACCEL / 2 + (COAST_END - ACCEL) + (1 - COAST_END) / 3;

export function wheelTravel(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  if (x < ACCEL) return (x * x) / (2 * ACCEL * DISTANCE);
  if (x < COAST_END) return (ACCEL / 2 + x - ACCEL) / DISTANCE;
  const coastDistance = ACCEL / 2 + COAST_END - ACCEL;
  const remaining = 1 - COAST_END;
  const u = (x - COAST_END) / remaining;
  return (coastDistance + remaining * (u - u * u + (u * u * u) / 3)) / DISTANCE;
}

export function wheelLandingRotation(from: number, index: number, count: number): number {
  const centre = ((index + 0.5) * 360) / count;
  return Math.ceil(from / 360) * 360 + WHEEL_TURNS * 360 + 360 - centre;
}

/** The audio pegs are the exact times a physical sector seam passes the pointer. */
export function wheelPegTimes(
  from: number,
  target: number,
  count: number,
  durationMs: number
): number[] {
  const sector = 360 / count;
  const times: number[] = [];
  for (let peg = Math.floor(from / sector) + 1; peg * sector < target; peg += 1) {
    const fraction = (peg * sector - from) / (target - from);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i += 1) {
      const mid = (lo + hi) / 2;
      if (wheelTravel(mid) < fraction) lo = mid;
      else hi = mid;
    }
    times.push(((lo + hi) / 2) * durationMs);
  }
  return times;
}
