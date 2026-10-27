export interface TableHudControlState {
  heroPromptedToAct: boolean;
  handSettling: boolean;
  handInProgress: boolean;
  rabbitAvailable: boolean;
  rabbitEnabled: boolean;
}

/** One physical slot, driven by the engine's terminal hand event. */
export function tableHudControl(state: TableHudControlState): 'timebank' | 'rabbit' | null {
  if (state.heroPromptedToAct && !state.handSettling) return 'timebank';
  if ((state.handSettling || !state.handInProgress) && state.rabbitAvailable && state.rabbitEnabled)
    return 'rabbit';
  return null;
}
