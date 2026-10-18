import type { Locator } from '@playwright/test';

/** Runs wholly inside one browser task: a refresh cannot detach selected nodes
 * between the visibility check and their geometry/font measurements. */
export function measureFinancialTouchControls(root: Element) {
  if (!root.isConnected) throw new Error('Financial console detached before measurement');

  // Match Playwright's :visible semantics, including display:contents text/children.
  // Opacity does not hide a target; offscreen controls remain part of this check.
  const visible = (element: Element): boolean => {
    if (!element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'contents') {
      return Array.from(element.childNodes).some((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) return visible(child as Element);
        if (child.nodeType !== Node.TEXT_NODE) return false;
        const range = element.ownerDocument.createRange();
        range.selectNode(child);
        const rect = range.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    }
    if (typeof element.checkVisibility === 'function') {
      if (!element.checkVisibility()) return false;
    } else {
      const details = element.closest('details,summary');
      if (details !== element && details?.tagName === 'DETAILS' && !details.hasAttribute('open')) {
        return false;
      }
    }
    if (style.visibility !== 'visible') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const number = (value: string): number => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const pseudoSize = (control: Element, pseudo: '::before' | '::after') => {
    const style = getComputedStyle(control, pseudo);
    if (style.content === 'none' || style.display === 'none') return { width: 0, height: 0 };
    const rect = control.getBoundingClientRect();
    return {
      width: Math.max(
        number(style.width),
        rect.width + Math.max(0, -number(style.left)) + Math.max(0, -number(style.right))
      ),
      height: Math.max(
        number(style.height),
        rect.height + Math.max(0, -number(style.top)) + Math.max(0, -number(style.bottom))
      ),
    };
  };
  const controls = Array.from(
    root.querySelectorAll(
      'button, a[href], summary, input, select, textarea, [role="button"], [role="tab"]'
    )
  ).filter(visible);
  const undersized = controls
    .map((control) => {
      const rect = control.getBoundingClientRect();
      const before = pseudoSize(control, '::before');
      const after = pseudoSize(control, '::after');
      return {
        label:
          control.getAttribute('aria-label') ||
          control.getAttribute('placeholder') ||
          (control.textContent || '').trim().slice(0, 80),
        width: Math.max(rect.width, before.width, after.width),
        height: Math.max(rect.height, before.height, after.height),
      };
    })
    .filter((control) => control.width < 44 || control.height < 44);
  const undersizedTextInputs = controls
    .filter((control) =>
      control.matches('input:not([type="checkbox"]):not([type="radio"]), select, textarea')
    )
    .map((control) => ({
      label: control.getAttribute('aria-label') || control.getAttribute('placeholder') || '',
      fontSize: Number.parseFloat(getComputedStyle(control).fontSize),
    }))
    .filter((control) => control.fontSize < 16);
  return { undersized, undersizedTextInputs };
}

export async function readFinancialTouchControls(root: Locator) {
  return root.evaluate(measureFinancialTouchControls);
}
