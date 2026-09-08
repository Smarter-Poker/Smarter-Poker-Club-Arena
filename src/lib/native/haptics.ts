/**
 * The phone's own haptic engine (native only). Loaded from
 * src/utils/vibrationGate.ts, only when the Capacitor bridge says native.
 *
 * On the web, iOS has no navigator.vibrate and the gate reaches for the
 * <input switch> trick; inside the app there is a real Taptic Engine and a
 * plugin that talks to it. A pattern longer than one pulse becomes a heavier
 * impact - the engine does not play arbitrary waveforms - which is the same
 * "weight" idea the gate already coalesces on.
 */
export async function nativeHaptic(pattern: number | number[]): Promise<boolean> {
  const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
  const pulses = Array.isArray(pattern) ? pattern.filter((_, i) => i % 2 === 0) : [pattern];
  const total = pulses.reduce((a, b) => a + (Number(b) || 0), 0);
  const style =
    total >= 60 ? ImpactStyle.Heavy : total >= 25 ? ImpactStyle.Medium : ImpactStyle.Light;
  await Haptics.impact({ style });
  return true;
}
