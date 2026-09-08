import type { AvatarSnapshot } from './avatarSnapshot';

/** A decorative copy from this table, not a replacement player identity. */
export function AvatarCopy({ snapshot }: { snapshot?: AvatarSnapshot }) {
  if (snapshot?.src) {
    return (
      <image
        href={snapshot.src}
        x={-50}
        y={-50}
        width={100}
        height={100}
        preserveAspectRatio="xMidYMid meet"
      />
    );
  }
  if (snapshot?.initial) {
    return (
      <text
        x={0}
        y={12}
        textAnchor="middle"
        fill="currentColor"
        fontFamily="system-ui"
        fontSize={40}
      >
        {snapshot.initial}
      </text>
    );
  }
  return null;
}
