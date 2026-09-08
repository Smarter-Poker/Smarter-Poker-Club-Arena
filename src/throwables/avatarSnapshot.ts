/** Read-only snapshot for performances that animate a copy of the avatar.
 * Never alter the real seat, its cards, cosmetics or action state.
 */
export interface AvatarSnapshot {
  src?: string;
  initial?: string;
}

export function captureThrowableAvatar(
  root: HTMLElement | null,
  seat: number
): AvatarSnapshot | undefined {
  if (!Number.isSafeInteger(seat) || seat < 1) return;
  const table = root?.closest('.table-page');
  // No document fallback: another open table can have the same seat number.
  const avatar = table?.querySelector<HTMLElement>(`[data-seat-num="${seat}"] .seat__avatar`);
  if (!avatar) return;
  const img = avatar.querySelector<HTMLImageElement>('.seat__avatar-img');
  if (img?.complete && img.naturalWidth > 0) {
    return { src: img.currentSrc || img.src };
  }
  const canvas = avatar.querySelector<HTMLCanvasElement>(
    'canvas.seat__avatar-rive, .seat__avatar-rive canvas'
  );
  if (canvas && canvas.width > 0 && canvas.height > 0) {
    try {
      return { src: canvas.toDataURL('image/png') };
    } catch {
      // Cross-origin canvases cannot be copied. The real avatar still renders.
    }
  }
  const initial = avatar.querySelector('.seat__avatar-initial')?.textContent?.trim();
  return initial ? { initial } : undefined;
}
