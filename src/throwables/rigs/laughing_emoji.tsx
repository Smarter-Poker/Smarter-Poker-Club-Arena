import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './laughing_emoji.css';
export const spec: ThrowableSpec = {
  id: 'laughing_emoji',
  name: 'Laugh With Tears',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 300, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.3, anchor: 'face', coversAvatar: true, ms: 3900 },
  beats: [
    { at: 300, marker: 'smug' },
    { at: 867, marker: 'laugh-start' },
    { at: 1267, marker: 'laugh-two' },
    { at: 1667, marker: 'tears' },
    { at: 2867, marker: 'laugh-swell' },
    { at: 4200, marker: 'cut' },
  ],
  // Recorded laugh swells are still pending; only the tear effects are shipped.
  audio: [
    { at: 1667, sample: 'drip' },
    { at: 2467, sample: 'drip' },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <AtlasSprite
        src="laughing_emoji"
        rect={[40, 70, 570, 550]}
        x={-60}
        y={-60}
        width={120}
        height={120}
      />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-laughing_emoji__rock">
        <g className="thr-laughing_emoji__smug">
          <AtlasSprite
            src="laughing_emoji"
            rect={[40, 70, 570, 550]}
            x={-60}
            y={-60}
            width={120}
            height={120}
          />
        </g>
        <g className="thr-laughing_emoji__laugh">
          <AtlasSprite
            src="laughing_emoji"
            rect={[650, 70, 560, 550]}
            x={-60}
            y={-60}
            width={120}
            height={120}
          />
        </g>
        <g className="thr-laughing_emoji__tears">
          <AtlasSprite
            src="laughing_emoji"
            rect={[610, 635, 635, 550]}
            x={-69}
            y={-60}
            width={138}
            height={120}
          />
        </g>
      </g>
      <g className="thr-laughing_emoji__left">
        <AtlasSprite
          src="laughing_emoji"
          rect={[1147, 1039, 64, 77]}
          x={-68}
          y={-12}
          width={14}
          height={18}
        />
      </g>
      <g className="thr-laughing_emoji__right">
        <AtlasSprite
          src="laughing_emoji"
          rect={[1147, 1039, 64, 77]}
          x={68}
          y={-12}
          width={14}
          height={18}
        />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
