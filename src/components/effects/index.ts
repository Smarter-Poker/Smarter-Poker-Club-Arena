/**
 * 2026-08-28 (Animation Law cleanup): WinSplash and the effects/ ChipAnimation
 * are DELETED, not just unexported. Neither was mounted anywhere, and both
 * carried the stale-closure completion-timer bug the live canvases were cured
 * of (an inline onComplete re-armed the timer forever) — dead code with a
 * known defect is a trap for whoever wires it in next. The live winner
 * celebration is ConfettiCanvas + ParticleSystem via TableModalsLayer; the
 * live chip flights are components/table/ChipAnimation.
 */
export { ConfettiEffect } from './ConfettiEffect';
