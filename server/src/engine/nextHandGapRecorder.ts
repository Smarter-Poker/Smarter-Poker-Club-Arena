import { HAND_COMPLETION } from '../config/handCompletionSpec.js';
import { NextHandGapRecorder } from './NextHandGap.js';

/** The process-wide recorder every table engine reports into; read by /health. */
export const nextHandGap = new NextHandGapRecorder(HAND_COMPLETION.NEXT_HAND_REST_MS);
