/**
 * Productivity Sidekick — Settings → Security Panel
 * ============================================================
 * Renders into a mount point inside the settingsModal. Handles:
 *   1. Status display — legacy (v1.2.x) vs secure (v1.3.0+)
 *   2. Regenerate button — calls AuthManager.generateNewRecoveryKitFromSettings()
 *   3. Key display — delegated to RecoveryKeyDisplay shared module
 *
 * Usage:
 *   SecuritySettingsPanel.mount(containerElement);
 */

'use strict';

const SecuritySettingsPanel = (function() {

    let mountPoint = null;
    let stylesInjected = false;

    const STYLES = `
        .security-panel { display: flex; flex-direction: column; gap: 14px; }
        .security-status {
            display: flex; align-items: flex-start; gap: 10px;
            padding: 12px 14px;
            border-radius: var(--radius-md, 8px);
            border: 1px solid var(--color-border, #e2e8f0);
            background: var(--bg-home, #f8fafc);
        }
        .security-status.legacy {
            border-left: 4px solid var(--color-warning, #f59e0b);
            background: #fffbeb;
        }
        .security-status.secure {
            border-left: 4px solid var(--color-success, #10b981);
            background: #f0fdf4;
        }
        .security-status.unknown {
            border-left: 4px solid var(--color-text-muted, #64748b);
        }
        body.dark-theme .security-status.legacy { background: #3d2815; }
        body.dark-theme .security-status.secure { background: #14321f; }
        .security-status-icon { font-size: 1.3em; flex-shrink: 0; line-height: 1; }
        .security-status-text { flex: 1; min-width: 0; }
        .security-status-label {
            font-size: 0.7em; font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--color-text-muted, #64748b);
            margin-bottom: 2px;
        }
        .security-status-value {
            font-size: 0.95em; font-weight: 700;
            color: var(--color-text, #0f172a);
        }
        .security-status-detail {
            font-size: 0.8em;
            color: var(--color-text-muted, #64748b);
            margin-top: 4px;
            line-height: 1.4;
        }
        .security-action-row { display: flex; flex-direction: column; gap: 4px; }
        .security-action-desc {
            font-size: 0.8em;
            color: var(--color-text-muted, #64748b);
            line-height: 1.4;
        }
        .security-btn-primary {
            background: var(--color-primary, #6366f1);
            color: white;
            border: none;
            padding: 10px 16px;
            border-radius: var(--radius-md, 8px);
            font-size: 0.9em; font-weight: 600;
            cursor: pointer;
            transition: background 0.15s, transform 0.15s;
            font-family: inherit;
        }
        .security-btn-primary:hover:not(:disabled) {
            background: var(--color-primary-hover, #4f46e5);
            transform: translateY(-1px);
        }
        .security-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
    `;

    function injectStyles() {
        if (stylesInjected) return;
        const style = document.createElement('style');
        style.id = 'security-settings-panel-styles';
        style.textContent = STYLES;
        document.head.appendChild(style);
        stylesInjected = true;
    }

    /**
     * Read the current recovery kit version from the live appState.
     * TODO: when Phase 4 micro-frontend decomposition lands, replace
     * this direct global read with an injected getter.
     */
    function readCurrentStatus() {
        try {
            const state = (typeof appState === 'object' && appState !== null) ? appState : null;
            if (!state) return 'unknown';
            const version = state?.preferences?.recoveryKitVersion;
            if (version === 2) return 'secure';
            if (version === undefined || version === null || version < 2) return 'legacy';
            return 'unknown';
        } catch {
            return 'unknown';
        }
    }

    function buildStatusElement() {
        const status = readCurrentStatus();
        const wrapper = document.createElement('div');
        wrapper.className = `security-status ${status}`;
        wrapper.setAttribute('role', 'status');
        wrapper.setAttribute('aria-live', 'polite');

        const icon = document.createElement('span');
        icon.className = 'security-status-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = status === 'secure' ? '🔒' : status === 'legacy' ? '⚠️' : '❓';
        wrapper.appendChild(icon);

        const text = document.createElement('div');
        text.className = 'security-status-text';

        const label = document.createElement('div');
        label.className = 'security-status-label';
        label.textContent = 'Recovery Kit Status';
        text.appendChild(label);

        const value = document.createElement('div');
        value.className = 'security-status-value';
        value.textContent = status === 'secure' ? 'v1.3.0 Secure Format'
            : status === 'legacy' ? 'Legacy Format — Upgrade Recommended'
            : 'Unknown';
        text.appendChild(value);

        const detail = document.createElement('div');
        detail.className = 'security-status-detail';
        detail.textContent = status === 'secure'
            ? 'Your recovery kit uses the strongest available encryption. Regenerate it if you believe your key has been compromised.'
            : status === 'legacy'
            ? 'Your account was created under an older encryption format. Generate a new recovery kit to take advantage of the latest security improvements.'
            : 'Status could not be determined. Try reloading the app.';
        text.appendChild(detail);

        wrapper.appendChild(text);
        return wrapper;
    }

    async function handleRegenerate(regenBtn, displayContainer) {
        if (!window.AuthManager || typeof window.AuthManager.generateNewRecoveryKitFromSettings !== 'function') {
            alert('Recovery kit generation is unavailable. Please reload and try again.');
            return;
        }

        const status = readCurrentStatus();
        if (status === 'secure') {
            if (!confirm('Your current recovery kit is already secure. Generating a new one '
                + 'will invalidate the old one. Any saved copies of the old recovery key '
                + 'will no longer work.\n\nContinue?')) {
                return;
            }
        }

        regenBtn.disabled = true;
        regenBtn.textContent = 'Generating...';

        try {
            const session = window.AuthManager.getSession();
            const email = session ? session.email : null;
            const { newRecoveryKey } = await window.AuthManager.generateNewRecoveryKitFromSettings();

            // Delegate to the shared module
            if (!window.RecoveryKeyDisplay) {
                throw new Error('RecoveryKeyDisplay module not loaded');
            }
            window.RecoveryKeyDisplay.render(displayContainer, {
                recoveryKey: newRecoveryKey,
                email: email,
                context: 'settings',
                onDismiss: () => {
                    refresh();
                },
            });
        } catch (err) {
            alert('Could not generate new recovery kit: ' + (err.message || 'Unknown error'));
            regenBtn.disabled = false;
            regenBtn.textContent = readCurrentStatus() === 'legacy'
                ? '🔐 Upgrade to Secure Format'
                : '🔄 Generate New Recovery Kit';
        }
    }

    function mount(container) {
        if (!container || !(container instanceof HTMLElement)) {
            throw new Error('SecuritySettingsPanel.mount: container element required');
        }
        injectStyles();
        mountPoint = container;
        refresh();
    }

    function refresh() {
        if (!mountPoint) return;
        while (mountPoint.firstChild) mountPoint.removeChild(mountPoint.firstChild);

        const panel = document.createElement('div');
        panel.className = 'security-panel';

        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; gap: 8px; '
            + 'font-weight: 700; font-size: 0.95em; color: var(--color-text);';
        header.textContent = '🛡️ Account Security';
        panel.appendChild(header);

        panel.appendChild(buildStatusElement());

        const actionRow = document.createElement('div');
        actionRow.className = 'security-action-row';

        const actionDesc = document.createElement('div');
        actionDesc.className = 'security-action-desc';
        const status = readCurrentStatus();
        actionDesc.textContent = status === 'legacy'
            ? 'Generate a new recovery kit using the latest secure format. Your old recovery key will stop working immediately.'
            : 'Regenerate your recovery kit. Use this if you believe your current key has been compromised or you lost your saved copy.';
        actionRow.appendChild(actionDesc);

        const regenBtn = document.createElement('button');
        regenBtn.type = 'button';
        regenBtn.className = 'security-btn-primary';
        regenBtn.textContent = status === 'legacy'
            ? '🔐 Upgrade to Secure Format'
            : '🔄 Generate New Recovery Kit';
        actionRow.appendChild(regenBtn);

        panel.appendChild(actionRow);

        const displayContainer = document.createElement('div');
        panel.appendChild(displayContainer);

        regenBtn.addEventListener('click', () => handleRegenerate(regenBtn, displayContainer));

        mountPoint.appendChild(panel);
    }

    return { mount, refresh };
})();

if (typeof window !== 'undefined') {
    window.SecuritySettingsPanel = SecuritySettingsPanel;
}
