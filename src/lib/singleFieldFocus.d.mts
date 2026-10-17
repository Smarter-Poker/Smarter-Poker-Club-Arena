export const FIELD_SELECTOR: string;
export const FOCUS_OWNER_ATTRIBUTE: string;
export function fieldFocusOwner(field: HTMLElement): HTMLElement;
export function installSingleFieldFocus(document: Document): () => void;
