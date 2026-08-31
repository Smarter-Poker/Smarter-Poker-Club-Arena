import { useEffect } from 'react';

/** Close the top-level dialog with Escape while leaving nested dialogs in control. */
export function useDialogEscape(isOpen: boolean, onClose: () => void, suspended = false): void {
  useEffect(() => {
    if (!isOpen || suspended) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, suspended]);
}
