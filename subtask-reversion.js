/**
 * Productivity Sidekick — Subtask Reversion Cool-down
 * ============================================================
 * When SUBTASK_UNCHECKED is emitted, delay the mutation by 3000ms.
 * If the user re-checks the same subtask within that window, cancel
 * the pending mutation entirely.
 *
 * Accessibility: aria-live="polite" region announces the undo window.
 *
 * Integration:
 *   const uninstall = installSubtaskReversionHandler(window.EventBus, {
 *       commitFn: (subtaskId) => taskAggregate.markSubtaskUnchecked(subtaskId),
 *       isAuthenticatedFn: () => AuthManager.isLoggedIn(),
 *   });
 */

'use strict';

const REVERSION_COOLDOWN_MS = 3000;
const ARIA_LIVE_REGION_ID = 'subtask-reversion-announcer';

function installSubtaskReversionHandler(eventBus, options) {
    if (!eventBus || typeof eventBus.on !== 'function') {
        throw new Error('installSubtaskReversionHandler: eventBus.on is required');
    }
    if (!options || typeof options.commitFn !== 'function') {
        throw new Error('installSubtaskReversionHandler: options.commitFn is required');
    }

    const commitFn = options.commitFn;
    const isAuthenticatedFn = typeof options.isAuthenticatedFn === 'function'
        ? options.isAuthenticatedFn
        : () => true;

    const pendingReversions = new Map();

    function ensureLiveRegion() {
        let region = document.getElementById(ARIA_LIVE_REGION_ID);
        if (!region) {
            region = document.createElement('div');
            region.id = ARIA_LIVE_REGION_ID;
            region.setAttribute('aria-live', 'polite');
            region.setAttribute('aria-atomic', 'true');
            region.style.cssText = 'position:absolute;width:1px;height:1px;'
                + 'padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);'
                + 'white-space:nowrap;border:0;';
            document.body.appendChild(region);
        }
        return region;
    }

    function announce(message) {
        const region = ensureLiveRegion();
        region.textContent = '';
        setTimeout(() => { region.textContent = message; }, 0);
    }

    function cancelPending(subtaskId) {
        const pending = pendingReversions.get(subtaskId);
        if (!pending) return false;
        clearTimeout(pending.timeoutId);
        pendingReversions.delete(subtaskId);
        eventBus.emit('SUBTASK_REVERSION_CANCELLED', { subtaskId });
        announce('Subtask change cancelled.');
        return true;
    }

    function handleUnchecked(payload) {
        if (!payload || typeof payload.subtaskId !== 'string') return;
        const subtaskId = payload.subtaskId;

        if (pendingReversions.has(subtaskId)) {
            cancelPending(subtaskId);
        }

        const timeoutId = setTimeout(async () => {
            pendingReversions.delete(subtaskId);

            if (!isAuthenticatedFn()) {
                eventBus.emit('SUBTASK_REVERSION_ABORTED', {
                    subtaskId,
                    reason: 'not_authenticated',
                });
                return;
            }

            try {
                await commitFn(subtaskId);
                eventBus.emit('SUBTASK_REVERSION_COMMITTED', { subtaskId });
            } catch (err) {
                eventBus.emit('SUBTASK_REVERSION_FAILED', {
                    subtaskId,
                    error: err && err.message ? err.message : String(err),
                });
            }
        }, REVERSION_COOLDOWN_MS);

        pendingReversions.set(subtaskId, { timeoutId, startedAt: Date.now() });
        eventBus.emit('SUBTASK_REVERSION_PENDING', {
            subtaskId,
            cooldownMs: REVERSION_COOLDOWN_MS,
        });
        announce('Subtask unchecked. Re-check within 3 seconds to undo.');
    }

    function handleChecked(payload) {
        if (!payload || typeof payload.subtaskId !== 'string') return;
        cancelPending(payload.subtaskId);
    }

    function handleLogout() {
        for (const [subtaskId, pending] of pendingReversions.entries()) {
            clearTimeout(pending.timeoutId);
            eventBus.emit('SUBTASK_REVERSION_ABORTED', { subtaskId, reason: 'logout' });
        }
        pendingReversions.clear();
    }

    const unsubUnchecked = eventBus.on('SUBTASK_UNCHECKED', handleUnchecked);
    const unsubChecked = eventBus.on('SUBTASK_CHECKED', handleChecked);
    const unsubLogout = eventBus.on('AUTH_LOGOUT', handleLogout);

    return function uninstall() {
        handleLogout();
        if (typeof unsubUnchecked === 'function') unsubUnchecked();
        if (typeof unsubChecked === 'function') unsubChecked();
        if (typeof unsubLogout === 'function') unsubLogout();
    };
}

if (typeof window !== 'undefined') {
    window.installSubtaskReversionHandler = installSubtaskReversionHandler;
}
