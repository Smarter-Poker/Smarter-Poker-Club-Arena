/** One focus edge per data-entry control, including composite search wells. */
export const FIELD_SELECTOR = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]):not([type="file"]),textarea,select,[contenteditable="true"],[contenteditable=""]';
export const FOCUS_OWNER_ATTRIBUTE = 'data-sp-field-focus-owner';

export function fieldFocusOwner(field) {
    const document = field.ownerDocument;
    const view = document.defaultView;
    if (!view) return field;
    const fieldRect = field.getBoundingClientRect();
    let candidate = field;
    for (let depth = 0; candidate && depth < 4; depth++, candidate = candidate.parentElement) {
        if (candidate === document.body || candidate === document.documentElement) break;
        const rect = candidate.getBoundingClientRect();
        if (candidate !== field && (candidate.querySelectorAll(FIELD_SELECTOR).length !== 1
            || rect.height > fieldRect.height + 64 || rect.width > Math.max(fieldRect.width * 1.8, fieldRect.width + 160))) break;
        const style = view.getComputedStyle(candidate);
        const edge = side => parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none';
        // One internal separator does not enclose a field.
        const border = (edge('Top') && edge('Bottom')) || (edge('Left') && edge('Right'));
        const roundedSurface = parseFloat(style.borderTopLeftRadius) > 0
            && style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
        // A transitioning focus shadow on a transparent input is not its frame.
        const paintedImage = candidate !== field && style.backgroundImage && style.backgroundImage !== 'none';
        if (border || roundedSurface || paintedImage || (candidate !== field && style.boxShadow && style.boxShadow !== 'none')) return candidate;
    }
    return field;
}

export function installSingleFieldFocus(document) {
    let owner = null;
    document.documentElement.setAttribute('data-sp-single-field-focus', '');
    const clear = () => { owner?.removeAttribute(FOCUS_OWNER_ATTRIBUTE); owner = null; };
    const focus = event => {
        const field = event.target;
        if (!field?.matches?.(FIELD_SELECTOR)) return;
        clear();
        owner = fieldFocusOwner(field);
        owner.setAttribute(FOCUS_OWNER_ATTRIBUTE, '');
    };
    const blur = event => { if (owner?.contains(event.target)) clear(); };
    document.addEventListener('focusin', focus, true);
    document.addEventListener('focusout', blur, true);
    if (document.activeElement?.matches?.(FIELD_SELECTOR)) focus({ target: document.activeElement });
    return () => {
        document.removeEventListener('focusin', focus, true);
        document.removeEventListener('focusout', blur, true);
        clear();
        document.documentElement.removeAttribute('data-sp-single-field-focus');
    };
}
