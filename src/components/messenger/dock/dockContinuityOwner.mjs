import { createContinuityController, continuityWorkspaceKey } from './messengerContinuity.mjs';

// One account/workspace owner survives native panel minimize/restore. The
// established controller then sees every newer edit before any delayed receipt.
export function createDockContinuityOwner({ getIdentity, notify }) {
    const controllers = new Map();
    let generation = 0;
    return {
        clear() { generation++; controllers.clear(); },
        get(actorId, workspace, options) {
            const key = `${actorId}:${continuityWorkspaceKey(workspace)}`;
            if (!controllers.has(key)) {
                const epoch = generation;
                controllers.set(key, createContinuityController({ ...options, actorId, workspace,
                    isCurrent: () => generation === epoch && getIdentity() === actorId,
                    changed: notify,
                }));
            }
            return controllers.get(key);
        },
    };
}
