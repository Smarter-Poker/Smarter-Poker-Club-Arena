/**
 * THE GAME IS HEARD WITH THE iPHONE ON SILENT (2026-09-26).
 *
 * Safari plays Web Audio in an "ambient" session by default, and an ambient
 * session is muted by the ring/silent switch. Most players keep that switch on
 * silent, so on most iPhones every card, chip and Diamond game cue was silent
 * with the app's own Sounds switch ON. Safari 16.4+ exposes
 * `navigator.audioSession`; its "playback" type is heard whatever the switch
 * says, like a video or a music app.
 *
 * The app's Sounds switch decides: ON asks for "playback", OFF sets "ambient"
 * (and the engine plays nothing anyway). The cost of "playback", said plainly:
 * like any app that plays sound, it pauses music another app was playing when
 * the game first makes a sound. A player who wants their music keeps it by
 * turning Sounds off here.
 *
 * Browsers without the API (everything but Safari today) are untouched.
 */
export type AudioSessionKind = 'playback' | 'ambient';

type AudioSessionLike = { type: string };

function session(): AudioSessionLike | null {
  try {
    if (typeof navigator === 'undefined') return null;
    const s = (navigator as unknown as { audioSession?: AudioSessionLike }).audioSession;
    return s && typeof s === 'object' && 'type' in s ? s : null;
  } catch {
    return null;
  }
}

/** True where the browser lets a page choose how its sound mixes (Safari 16.4+). */
export function audioSessionSupported(): boolean {
  return session() !== null;
}

/** Set the session for the Sounds switch. Returns what is now in force, or null where unsupported. */
export function applyAudioSession(soundOn: boolean): AudioSessionKind | null {
  const s = session();
  if (!s) return null;
  const want: AudioSessionKind = soundOn ? 'playback' : 'ambient';
  try {
    if (s.type !== want) s.type = want;
    return want;
  } catch {
    return null;
  }
}

/** The session type in force, for the device check, or null where unsupported. */
export function currentAudioSession(): string | null {
  try {
    return session()?.type ?? null;
  } catch {
    return null;
  }
}
