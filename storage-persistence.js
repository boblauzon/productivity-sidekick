/**
 * Productivity Sidekick — Epic 104: Storage Persistence & Sync Hardening
 * ============================================================
 * Three hardening features:
 *   1. requestPersistentStorage() — marks IndexedDB as persistent
 *   2. installOnlineSyncDrain(drainFn) — drains outbox on reconnect
 *   3. installUnsavedChangesGuard(getQueueSizeFn) — beforeunload warning
 *
 * v1.3.0 ships with #1 fully active; #2 and #3 are installed but idle
 * (their callbacks return 0/no-op until v1.4.0 wires the real outbox).
 */

'use strict';

const StoragePersistence = (function() {

    async function requestPersistentStorage() {
        if (typeof navigator === 'undefined' || !navigator.storage) {
            return { supported: false, alreadyPersistent: false, persisted: false,
                reason: 'navigator.storage API unavailable' };
        }
        if (typeof navigator.storage.persist !== 'function') {
            return { supported: false, alreadyPersistent: false, persisted: false,
                reason: 'navigator.storage.persist not implemented' };
        }
        try {
            const alreadyPersistent = typeof navigator.storage.persisted === 'function'
                ? await navigator.storage.persisted()
                : false;
            if (alreadyPersistent) {
                return { supported: true, alreadyPersistent: true, persisted: true };
            }
            const granted = await navigator.storage.persist();
            return { supported: true, alreadyPersistent: false, persisted: granted,
                reason: granted ? undefined : 'Browser denied persistence request' };
        } catch (err) {
            return { supported: true, alreadyPersistent: false, persisted: false,
                reason: `persist() threw: ${err.message}` };
        }
    }

    async function estimateStorageUsage() {
        if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
            return { supported: false };
        }
        try {
            const est = await navigator.storage.estimate();
            const usage = est.usage || 0;
            const quota = est.quota || 0;
            return {
                supported: true,
                usageBytes: usage,
                quotaBytes: quota,
                percentUsed: quota > 0 ? Math.round((usage / quota) * 1000) / 10 : 0,
            };
        } catch {
            return { supported: false };
        }
    }

    // --- Online sync drain ---
    let onlineHandlerInstalled = false;
    let installedDrainFn = null;
    let installedEventBus = null;

    function installOnlineSyncDrain(drainFn, eventBus) {
        if (typeof drainFn !== 'function') {
            throw new Error('installOnlineSyncDrain: drainFn must be a function');
        }
        if (onlineHandlerInstalled) uninstallOnlineSyncDrain();

        installedDrainFn = drainFn;
        installedEventBus = eventBus || null;
        window.addEventListener('online', handleOnline);
        window.addEventListener('pageshow', handlePageShow);
        onlineHandlerInstalled = true;
        return uninstallOnlineSyncDrain;
    }

    function uninstallOnlineSyncDrain() {
        if (!onlineHandlerInstalled) return;
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('pageshow', handlePageShow);
        onlineHandlerInstalled = false;
        installedDrainFn = null;
        installedEventBus = null;
    }

    async function handleOnline() { await runDrain('online_event'); }

    async function handlePageShow(event) {
        if (event && event.persisted && navigator.onLine) {
            await runDrain('bfcache_restore');
        }
    }

    async function runDrain(trigger) {
        if (!installedDrainFn) return;
        if (installedEventBus) installedEventBus.emit('OUTBOX_DRAIN_STARTED', { trigger });
        try {
            await installedDrainFn();
            if (installedEventBus) installedEventBus.emit('OUTBOX_DRAIN_SUCCEEDED', { trigger });
        } catch (err) {
            if (installedEventBus) {
                installedEventBus.emit('OUTBOX_DRAIN_FAILED', {
                    trigger,
                    error: err && err.message ? err.message : String(err),
                });
            }
        }
    }

    // --- Unsaved changes guard ---
    let unloadHandlerInstalled = false;
    let installedQueueSizeFn = null;

    function installUnsavedChangesGuard(getQueueSizeFn) {
        if (typeof getQueueSizeFn !== 'function') {
            throw new Error('installUnsavedChangesGuard: getQueueSizeFn must be a function');
        }
        if (unloadHandlerInstalled) uninstallUnsavedChangesGuard();
        installedQueueSizeFn = getQueueSizeFn;
        window.addEventListener('beforeunload', handleBeforeUnload);
        unloadHandlerInstalled = true;
        return uninstallUnsavedChangesGuard;
    }

    function uninstallUnsavedChangesGuard() {
        if (!unloadHandlerInstalled) return;
        window.removeEventListener('beforeunload', handleBeforeUnload);
        unloadHandlerInstalled = false;
        installedQueueSizeFn = null;
    }

    function handleBeforeUnload(event) {
        if (!installedQueueSizeFn) return;
        let queueSize = 0;
        try { queueSize = installedQueueSizeFn() || 0; }
        catch { return; }
        if (queueSize > 0) {
            event.preventDefault();
            event.returnValue = 'You have unsynced changes. Leaving now may cause data loss.';
            return event.returnValue;
        }
    }

    return {
        requestPersistentStorage,
        estimateStorageUsage,
        installOnlineSyncDrain,
        installUnsavedChangesGuard,
    };
})();

if (typeof window !== 'undefined') {
    window.StoragePersistence = StoragePersistence;
}
