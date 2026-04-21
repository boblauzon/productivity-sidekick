/**
 * Productivity Sidekick — Toast Notification System
 * ============================================================
 * Non-blocking EventBus-wired notifications. First concrete consumer is
 * Recovery Kit Upgrade. API is designed for future toasts.
 *
 * Public API:
 *   ToastManager.show({ id, title, body, variant, persistent, action })
 *   ToastManager.dismiss(id)
 *   ToastManager.dismissAll()
 *   ToastManager.installEventBusListeners(eventBus)
 */

'use strict';

const ToastManager = (function() {

    const CONTAINER_ID = 'toast-container';
    const DEFAULT_DURATION_MS = 6000;
    const ANIMATION_MS = 250;

    let stylesInjected = false;
    let containerEl = null;
    const activeToasts = new Map();

    const STYLES = `
        #${CONTAINER_ID} {
            position: fixed; top: 20px; right: 20px;
            z-index: 9998;
            display: flex; flex-direction: column; gap: 12px;
            max-width: 380px;
            width: calc(100vw - 40px);
            pointer-events: none;
            font-family: var(--font-body, system-ui, sans-serif);
        }
        @media (max-width: 600px) {
            #${CONTAINER_ID} {
                top: auto; bottom: 20px; left: 20px; right: 20px; max-width: none;
            }
        }
        .toast {
            background: var(--bg-template, #ffffff);
            color: var(--color-text, #0f172a);
            border-radius: var(--radius-lg, 12px);
            box-shadow: 0 10px 25px -5px rgba(0,0,0,0.18), 0 4px 6px -2px rgba(0,0,0,0.05);
            border: 1px solid var(--color-border, #e2e8f0);
            border-left: 4px solid var(--color-primary, #6366f1);
            padding: 14px 16px;
            pointer-events: auto;
            display: flex; flex-direction: column; gap: 10px;
            animation: toast-slide-in ${ANIMATION_MS}ms cubic-bezier(0.16, 1, 0.3, 1);
            transform-origin: top right;
        }
        .toast.toast-dismissing {
            animation: toast-slide-out ${ANIMATION_MS}ms cubic-bezier(0.4, 0, 1, 1) forwards;
        }
        .toast.toast-info    { border-left-color: var(--color-primary, #6366f1); }
        .toast.toast-success { border-left-color: var(--color-success, #10b981); }
        .toast.toast-warning { border-left-color: var(--color-warning, #f59e0b); }
        .toast.toast-danger  { border-left-color: var(--color-danger, #ef4444); }
        @keyframes toast-slide-in {
            from { transform: translateX(120%) scale(0.95); opacity: 0; }
            to   { transform: translateX(0) scale(1); opacity: 1; }
        }
        @keyframes toast-slide-out {
            from { transform: translateX(0) scale(1); opacity: 1; }
            to   { transform: translateX(120%) scale(0.95); opacity: 0; }
        }
        .toast-header { display: flex; align-items: flex-start; gap: 10px; }
        .toast-icon { font-size: 1.3em; flex-shrink: 0; line-height: 1; margin-top: 1px; }
        .toast-content { flex: 1; min-width: 0; }
        .toast-title { font-weight: 700; font-size: 0.92em; margin: 0 0 2px 0; }
        .toast-body {
            font-size: 0.83em; line-height: 1.45;
            color: var(--color-text-muted, #64748b);
            margin: 0;
        }
        .toast-close {
            background: none; border: none;
            color: var(--color-text-muted, #64748b);
            font-size: 1.1em; line-height: 1;
            padding: 2px 6px;
            cursor: pointer;
            border-radius: 4px;
            flex-shrink: 0;
            transition: background 0.15s, color 0.15s;
        }
        .toast-close:hover { background: var(--bg-home, #f8fafc); color: var(--color-text, #0f172a); }
        .toast-close:focus { outline: 2px solid var(--color-primary, #6366f1); outline-offset: 1px; }
        .toast-actions { display: flex; gap: 8px; margin-left: 33px; }
        .toast-action-btn {
            background: var(--color-primary, #6366f1); color: white;
            border: none;
            border-radius: var(--radius-md, 8px);
            padding: 6px 12px;
            font-size: 0.82em; font-weight: 600;
            cursor: pointer; font-family: inherit;
            transition: background 0.15s, transform 0.15s;
        }
        .toast-action-btn:hover { background: var(--color-primary-hover, #4f46e5); transform: translateY(-1px); }
        .toast-action-btn:focus { outline: 2px solid var(--color-primary, #6366f1); outline-offset: 2px; }
        .toast-action-btn.secondary {
            background: transparent;
            color: var(--color-text-muted, #64748b);
            border: 1px solid var(--color-border, #e2e8f0);
        }
        .toast-action-btn.secondary:hover {
            background: var(--bg-home, #f8fafc);
            color: var(--color-text, #0f172a);
        }
    `;

    function injectStyles() {
        if (stylesInjected) return;
        const style = document.createElement('style');
        style.id = 'toast-notifications-styles';
        style.textContent = STYLES;
        document.head.appendChild(style);
        stylesInjected = true;
    }

    function ensureContainer() {
        if (containerEl) return containerEl;
        injectStyles();
        containerEl = document.createElement('div');
        containerEl.id = CONTAINER_ID;
        containerEl.setAttribute('aria-live', 'polite');
        containerEl.setAttribute('aria-atomic', 'false');
        document.body.appendChild(containerEl);
        return containerEl;
    }

    function buildToast(config) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${config.variant || 'info'}`;
        toast.setAttribute('role', 'status');
        toast.dataset.toastId = config.id;

        const header = document.createElement('div');
        header.className = 'toast-header';

        const icon = document.createElement('span');
        icon.className = 'toast-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = config.icon || iconForVariant(config.variant);
        header.appendChild(icon);

        const content = document.createElement('div');
        content.className = 'toast-content';
        if (config.title) {
            const title = document.createElement('div');
            title.className = 'toast-title';
            title.textContent = config.title;
            content.appendChild(title);
        }
        if (config.body) {
            const body = document.createElement('p');
            body.className = 'toast-body';
            body.textContent = config.body;
            content.appendChild(body);
        }
        header.appendChild(content);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'toast-close';
        closeBtn.setAttribute('aria-label', 'Dismiss notification');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => dismiss(config.id));
        header.appendChild(closeBtn);

        toast.appendChild(header);

        if (config.action || config.secondaryAction) {
            const actions = document.createElement('div');
            actions.className = 'toast-actions';
            if (config.action) {
                const actionBtn = document.createElement('button');
                actionBtn.type = 'button';
                actionBtn.className = 'toast-action-btn';
                actionBtn.textContent = config.action.label;
                actionBtn.addEventListener('click', async () => {
                    try { await config.action.handler(); }
                    catch (err) { console.error('Toast action failed:', err); }
                });
                actions.appendChild(actionBtn);
            }
            if (config.secondaryAction) {
                const secBtn = document.createElement('button');
                secBtn.type = 'button';
                secBtn.className = 'toast-action-btn secondary';
                secBtn.textContent = config.secondaryAction.label;
                secBtn.addEventListener('click', async () => {
                    try { await config.secondaryAction.handler(); }
                    catch (err) { console.error('Toast secondary action failed:', err); }
                });
                actions.appendChild(secBtn);
            }
            toast.appendChild(actions);
        }

        toast.tabIndex = 0;
        toast.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') dismiss(config.id);
        });

        return toast;
    }

    function iconForVariant(variant) {
        switch (variant) {
            case 'success': return '✅';
            case 'warning': return '⚠️';
            case 'danger':  return '❌';
            default:        return 'ℹ️';
        }
    }

    function show(config) {
        if (!config || !config.id || !config.title) {
            console.warn('ToastManager.show: id and title are required');
            return;
        }
        ensureContainer();

        if (activeToasts.has(config.id)) {
            const existing = activeToasts.get(config.id);
            if (existing.timeoutId) clearTimeout(existing.timeoutId);
            const newEl = buildToast(config);
            existing.el.replaceWith(newEl);
            const timeoutId = scheduleAutoDismiss(config);
            activeToasts.set(config.id, { el: newEl, timeoutId });
            return;
        }

        const toastEl = buildToast(config);
        if (containerEl.firstChild) {
            containerEl.insertBefore(toastEl, containerEl.firstChild);
        } else {
            containerEl.appendChild(toastEl);
        }

        const timeoutId = scheduleAutoDismiss(config);
        activeToasts.set(config.id, { el: toastEl, timeoutId });
    }

    function scheduleAutoDismiss(config) {
        if (config.persistent) return null;
        const duration = typeof config.durationMs === 'number' ? config.durationMs : DEFAULT_DURATION_MS;
        return setTimeout(() => dismiss(config.id), duration);
    }

    function dismiss(id) {
        const entry = activeToasts.get(id);
        if (!entry) return;
        if (entry.timeoutId) clearTimeout(entry.timeoutId);
        activeToasts.delete(id);

        entry.el.classList.add('toast-dismissing');
        setTimeout(() => {
            if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
        }, ANIMATION_MS);
    }

    function dismissAll() {
        for (const id of Array.from(activeToasts.keys())) dismiss(id);
    }

    function installEventBusListeners(eventBus) {
        if (!eventBus || typeof eventBus.on !== 'function') {
            console.warn('ToastManager: EventBus not available, skipping wiring');
            return;
        }

        eventBus.on('UPGRADE_RECOVERY_KIT_NEEDED', () => {
            show({
                id: 'recovery-kit-upgrade',
                icon: '🔐',
                title: 'Security Upgrade Available',
                body: 'Your account has been upgraded to enhanced encryption. Please generate and download a new Recovery Kit from Settings to ensure you can recover your account.',
                variant: 'info',
                persistent: true,
                action: {
                    label: 'Generate Now',
                    handler: handleGenerateRecoveryKitAction,
                },
                secondaryAction: {
                    label: 'Remind Me Later',
                    handler: () => dismiss('recovery-kit-upgrade'),
                },
            });
        });

        eventBus.on('RECOVERY_KIT_UPGRADED', () => {
            dismiss('recovery-kit-upgrade');
            show({
                id: 'recovery-kit-upgraded-success',
                icon: '✅',
                title: 'Recovery Kit Updated',
                body: 'Your new recovery kit is active. Make sure you saved the recovery key in a safe place.',
                variant: 'success',
                durationMs: 8000,
            });
        });

        eventBus.on('AUTH_LOGOUT', () => {
            dismissAll();
        });
    }

    async function handleGenerateRecoveryKitAction() {
        if (!window.AuthManager || typeof window.AuthManager.generateNewRecoveryKitFromSettings !== 'function') {
            console.error('AuthManager.generateNewRecoveryKitFromSettings not available');
            return;
        }

        show({
            id: 'recovery-kit-generating',
            icon: '⏳',
            title: 'Generating new recovery kit...',
            body: 'This will take a moment.',
            variant: 'info',
            persistent: true,
        });

        try {
            const { newRecoveryKey } = await window.AuthManager.generateNewRecoveryKitFromSettings();
            dismiss('recovery-kit-generating');

            // Display the key via the shared module if it's available
            if (window.RecoveryKeyDisplay && typeof window.RecoveryKeyDisplay.render === 'function') {
                // Create a temporary overlay container
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.5); '
                    + 'z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 20px;';
                const container = document.createElement('div');
                container.style.cssText = 'max-width: 500px; width: 100%;';
                overlay.appendChild(container);
                document.body.appendChild(overlay);

                const session = window.AuthManager.getSession();
                window.RecoveryKeyDisplay.render(container, {
                    recoveryKey: newRecoveryKey,
                    email: session ? session.email : '',
                    context: 'settings',
                    onDismiss: () => {
                        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                    },
                });
            } else {
                window.prompt(
                    'Your new recovery key (SAVE THIS — you will not see it again):',
                    newRecoveryKey
                );
            }
        } catch (err) {
            dismiss('recovery-kit-generating');
            show({
                id: 'recovery-kit-error',
                icon: '❌',
                title: 'Could not generate recovery kit',
                body: err && err.message ? err.message : 'Please try again from Settings → Security.',
                variant: 'danger',
                durationMs: 10000,
            });
        }
    }

    return { show, dismiss, dismissAll, installEventBusListeners };
})();

if (typeof window !== 'undefined') {
    window.ToastManager = ToastManager;
}
