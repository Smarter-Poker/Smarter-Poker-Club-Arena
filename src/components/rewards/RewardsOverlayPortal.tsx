import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Keep Rewards dialogs outside the casino page's isolated display layer. */
export default function RewardsOverlayPortal({ children }: { children: ReactNode }) {
  return typeof document === 'undefined' ? null : createPortal(children, document.body);
}
