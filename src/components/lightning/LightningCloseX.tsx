/** The corner X every Lightning sheet carries (drawn, so no glyph or emoji in source). */
export default function LightningCloseX({
  onClick,
  testId,
}: {
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className="lightning-sheet__close"
      aria-label="Close"
      data-testid={testId}
      onClick={onClick}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M3 3 L13 13 M13 3 L3 13"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
