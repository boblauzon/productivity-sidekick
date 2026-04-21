/**
 * Productivity Sidekick — Session Locked Resume Modal
 * ============================================================
 * Triggered when the crypto worker has been terminated (typically by
 * iOS Safari freezing a backgrounded tab) and the user attempts an
 * operation that requires the master key.
 *
 * Goals:
 *   1. PRESERVE UI STATE — overlay, not navigate
 *   2. EXPLAIN WHY — "paused for security", not a technical error
 *   3. SINGLE FRICTION POINT — password only (email is known)
 *   4. ESCAPE HATCH — "Save my work and log out" downloads plaintext vault
 *      with TWO-STEP warning (confirm dialog + post-download checklist)
 *
 * Integration:
 *   await window.SessionLockModal.show(email);
 *   // resolves on successful re-auth
 *   // rejects if user clicks "Save and log out"
 */

'use strict';

const SessionLockModal = (function() {

    let modalEl = null;
    let stylesInjected = false;
    let activePromiseResolve = null;
    let activePromiseReject = null;
    let previouslyFocusedElement = null;

    const STYLES = `
        .session-lock-overlay {
            position: fixed; inset: 0;
            background: rgba(15, 23, 42, 0.78);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            z-index: 99999;
            display: flex; align-items: center; justify-content: center;
            padding: 20px;
            font-family: var(--font-body, system-ui, sans-serif);
            animation: session-lock-fade-in 200ms ease-out;
        }
        @keyframes session-lock-fade-in { from { opacity: 0; } to { opacity: 1; } }
        .session-lock-card {
            background: var(--bg-template, #ffffff);
            color: var(--color-text, #0f172a);
            border-radius: var(--radius-lg, 12px);
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            max-width: 420px; width: 100%;
            padding: 28px;
            border-top: 4px solid var(--color-primary, #6366f1);
            animation: session-lock-slide-up 250ms ease-out;
        }
        @keyframes session-lock-slide-up {
            from { transform: translateY(20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }
        .session-lock-card h2 {
            margin: 0 0 8px 0;
            font-size: 1.4em; font-weight: 800;
            display: flex; align-items: center; gap: 10px;
        }
        .session-lock-icon { font-size: 1.4em; }
        .session-lock-card p {
            margin: 0 0 16px 0;
            font-size: 0.9em; line-height: 1.5;
            color: var(--color-text-muted, #64748b);
        }
        .session-lock-email {
            display: block;
            font-family: var(--font-mono, monospace);
            font-size: 0.85em;
            background: var(--bg-home, #f8fafc);
            padding: 8px 12px;
            border-radius: 6px;
            margin-bottom: 16px;
            word-break: break-all;
            border: 1px solid var(--color-border, #e2e8f0);
        }
        .session-lock-card label {
            display: block;
            font-size: 0.75em; font-weight: 700;
            text-transform: uppercase;
            color: var(--color-text-muted, #64748b);
            margin-bottom: 4px;
            letter-spacing: 0.5px;
        }
        .session-lock-card input[type="password"] {
            width: 100%;
            padding: 12px;
            font-size: 1em;
            border: 1px solid var(--color-border, #e2e8f0);
            border-radius: var(--radius-md, 8px);
            background: var(--bg-template, #ffffff);
            color: var(--color-text, #0f172a);
            box-sizing: border-box;
            font-family: inherit;
        }
        .session-lock-card input[type="password"]:focus {
            outline: none;
            border-color: var(--color-primary, #6366f1);
            box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
        }
        .session-lock-error {
            color: var(--color-danger, #ef4444);
            font-size: 0.85em;
            margin: 8px 0 0 0;
            min-height: 1.2em;
            font-weight: 500;
        }
        .session-lock-actions {
            display: flex; flex-direction: column; gap: 10px;
            margin-top: 18px;
        }
        .session-lock-card button {
            width: 100%;
            padding: 12px;
            font-size: 0.95em; font-weight: 600;
            border: none;
            border-radius: var(--radius-md, 8px);
            cursor: pointer;
            font-family: inherit;
            transition: all 0.15s;
        }
        .session-lock-card button.primary {
            background: var(--color-primary, #6366f1);
            color: white;
        }
        .session-lock-card button.primary:hover:not(:disabled) {
            background: var(--color-primary-hover, #4f46e5);
            transform: translateY(-1px);
        }
        .session-lock-card button.primary:disabled {
            opacity: 0.6; cursor: not-allowed;
        }
        .session-lock-card button.secondary {
            background: transparent;
            color: var(--color-text-muted, #64748b);
            border: 1px solid var(--color-border, #e2e8f0);
        }
        .session-lock-card button.secondary:hover {
            background: var(--bg-home, #f8fafc);
            color: var(--color-danger, #ef4444);
            border-color: var(--color-danger, #ef4444);
        }
        body.dark-theme .session-lock-overlay { background: rgba(0, 0, 0, 0.85); }
    `;

    function injectStyles() {
        if (stylesInjected) return;
        const style = document.createElement('style');
        style.id = 'session-lock-styles';
        style.textContent = STYLES;
        document.head.appendChild(style);
        stylesInjected = true;
    }

    function handleTabTrap(event) {
        if (event.key !== 'Tab' || !modalEl) return;
        const focusable = modalEl.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus();
        }
    }

    function handleEscape(event) {
        if (event.key === 'Escape' && modalEl) handleCancel();
    }

    function build(email) {
        const overlay = document.createElement('div');
        overlay.className = 'session-lock-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'session-lock-title');
        overlay.setAttribute('aria-describedby', 'session-lock-desc');

        const card = document.createElement('div');
        card.className = 'session-lock-card';

        const title = document.createElement('h2');
        title.id = 'session-lock-title';
        const icon = document.createElement('span');
        icon.className = 'session-lock-icon';
        icon.textContent = '🔒';
        icon.setAttribute('aria-hidden', 'true');
        title.appendChild(icon);
        title.appendChild(document.createTextNode('Session Paused'));
        card.appendChild(title);

        const desc = document.createElement('p');
        desc.id = 'session-lock-desc';
        desc.textContent = 'Your session was paused for security. '
            + 'Re-enter your password to continue exactly where you left off. '
            + 'Your unsaved work has been preserved.';
        card.appendChild(desc);

        const emailLine = document.createElement('span');
        emailLine.className = 'session-lock-email';
        emailLine.textContent = email;
        card.appendChild(emailLine);

        const label = document.createElement('label');
        label.htmlFor = 'session-lock-password';
        label.textContent = 'Master Password';
        card.appendChild(label);

        const passwordInput = document.createElement('input');
        passwordInput.type = 'password';
        passwordInput.id = 'session-lock-password';
        passwordInput.autocomplete = 'current-password';
        passwordInput.setAttribute('aria-required', 'true');
        passwordInput.setAttribute('aria-describedby', 'session-lock-error');
        card.appendChild(passwordInput);

        const errorEl = document.createElement('p');
        errorEl.className = 'session-lock-error';
        errorEl.id = 'session-lock-error';
        errorEl.setAttribute('aria-live', 'assertive');
        errorEl.setAttribute('aria-atomic', 'true');
        card.appendChild(errorEl);

        const actions = document.createElement('div');
        actions.className = 'session-lock-actions';

        const unlockBtn = document.createElement('button');
        unlockBtn.type = 'button';
        unlockBtn.className = 'primary';
        unlockBtn.textContent = '🔓 Resume Session';
        actions.appendChild(unlockBtn);

        const escapeBtn = document.createElement('button');
        escapeBtn.type = 'button';
        escapeBtn.className = 'secondary';
        escapeBtn.textContent = 'Save my work and log out';
        actions.appendChild(escapeBtn);

        card.appendChild(actions);
        overlay.appendChild(card);

        unlockBtn.addEventListener('click', () => handleUnlock(email, passwordInput, errorEl, unlockBtn));
        escapeBtn.addEventListener('click', handleCancel);
        passwordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleUnlock(email, passwordInput, errorEl, unlockBtn);
            }
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) passwordInput.focus();
        });

        return { overlay, passwordInput, errorEl, unlockBtn };
    }

    async function handleUnlock(email, passwordInput, errorEl, unlockBtn) {
        const password = passwordInput.value;
        if (!password) {
            errorEl.textContent = 'Password is required.';
            passwordInput.focus();
            return;
        }

        unlockBtn.disabled = true;
        unlockBtn.textContent = 'Verifying...';
        errorEl.textContent = '';

        try {
            await window.CryptoClient.deriveFromPassword(password, email);
            passwordInput.value = '';

            if (window.EventBus) {
                window.EventBus.emit('SESSION_RESUMED', { email });
            }

            destroy();
            if (activePromiseResolve) {
                const resolve = activePromiseResolve;
                activePromiseResolve = null;
                activePromiseReject = null;
                resolve();
            }
        } catch (err) {
            errorEl.textContent = 'Could not verify password. Please try again.';
            unlockBtn.disabled = false;
            unlockBtn.textContent = '🔓 Resume Session';
            passwordInput.focus();
            passwordInput.select();
        }
    }

    /**
     * TWO-STEP plaintext export warning.
     * Step 1: Blocking confirm() dialog
     * Step 2: Post-download checklist with acknowledgment checkbox
     */
    function handleCancel() {
        const warning =
            '⚠️ SECURITY WARNING ⚠️\n\n' +
            'You are about to download a file containing your UNENCRYPTED data.\n\n' +
            'This file includes:\n' +
            '  • All your tasks and bookmarks\n' +
            '  • Notes and activity logs\n' +
            '  • Focus session history\n\n' +
            'You MUST delete this file immediately after restoring your vault.\n' +
            'Do not email it, do not upload it to cloud storage, and do not\n' +
            'leave it in your Downloads folder.\n\n' +
            'Click OK to download, or Cancel to go back and re-enter your password.';

        if (!window.confirm(warning)) {
            const pwField = modalEl && modalEl.querySelector('#session-lock-password');
            if (pwField) pwField.focus();
            return;
        }

        let exported = false;
        try {
            if (typeof appState === 'object' && appState !== null) {
                const exportPayload = {
                    _warning: 'THIS FILE CONTAINS UNENCRYPTED DATA. DELETE AFTER RESTORE.',
                    _exportedAt: new Date().toISOString(),
                    _appVersion: (typeof APP_VERSION !== 'undefined') ? APP_VERSION : 'unknown',
                    _instructions: 'Log back in to Productivity Sidekick, then use Settings → Import Backup to restore. After successful import, delete this file.',
                    vault: appState,
                };
                const blob = new Blob(
                    [JSON.stringify(exportPayload, null, 2)],
                    { type: 'application/json' }
                );
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `productivity-sidekick-RECOVERY-DELETE-AFTER-USE-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(a.href);
                exported = true;
            }
        } catch (err) {
            console.warn('Could not export state during session lock cancel:', err);
        }

        if (exported && modalEl) {
            showPostExportReminder();
            return;
        }

        tearDownAndLogout();
    }

    function showPostExportReminder() {
        if (!modalEl) return;
        const card = modalEl.querySelector('.session-lock-card');
        if (!card) { tearDownAndLogout(); return; }

        while (card.firstChild) card.removeChild(card.firstChild);

        const title = document.createElement('h2');
        title.id = 'session-lock-title';
        const icon = document.createElement('span');
        icon.className = 'session-lock-icon';
        icon.textContent = '⚠️';
        icon.setAttribute('aria-hidden', 'true');
        title.appendChild(icon);
        title.appendChild(document.createTextNode('File Downloaded'));
        card.appendChild(title);

        const desc = document.createElement('p');
        desc.id = 'session-lock-desc';
        desc.style.cssText = 'background: #fef2f2; border-left: 3px solid #ef4444; padding: 12px; border-radius: 6px; color: #7f1d1d; font-weight: 500;';
        desc.textContent = 'Your data has been saved as an UNENCRYPTED file. '
            + 'You must delete it immediately after restoring your vault on next login. '
            + 'Anyone with access to your Downloads folder can read this file.';
        card.appendChild(desc);

        const checklist = document.createElement('div');
        checklist.style.cssText = 'margin: 16px 0; font-size: 0.85em; color: var(--color-text-muted);';
        const ul = document.createElement('ul');
        ul.style.cssText = 'padding-left: 20px; margin: 0;';
        [
            'Move the file to a secure location (or note its filename)',
            'After your next login, use Settings → Import Backup',
            'Delete the file from Downloads and empty your trash',
        ].forEach((step) => {
            const li = document.createElement('li');
            li.textContent = step;
            li.style.marginBottom = '4px';
            ul.appendChild(li);
        });
        checklist.appendChild(ul);
        card.appendChild(checklist);

        const ackLabel = document.createElement('label');
        ackLabel.style.cssText = 'display: flex; align-items: flex-start; gap: 8px; padding: 12px; background: var(--bg-home); border-radius: 6px; cursor: pointer; font-size: 0.85em; margin-bottom: 12px;';
        const ackCb = document.createElement('input');
        ackCb.type = 'checkbox';
        ackCb.id = 'session-lock-ack';
        ackCb.style.cssText = 'width: auto; margin: 2px 0 0 0; flex-shrink: 0; cursor: pointer;';
        ackLabel.appendChild(ackCb);
        const ackText = document.createElement('span');
        ackText.textContent = 'I understand this file is unencrypted and I will delete it after restoring my vault.';
        ackLabel.appendChild(ackText);
        card.appendChild(ackLabel);

        const actions = document.createElement('div');
        actions.className = 'session-lock-actions';
        const finalBtn = document.createElement('button');
        finalBtn.type = 'button';
        finalBtn.className = 'primary';
        finalBtn.textContent = 'Log out';
        finalBtn.disabled = true;
        actions.appendChild(finalBtn);
        card.appendChild(actions);

        ackCb.addEventListener('change', () => {
            finalBtn.disabled = !ackCb.checked;
        });
        finalBtn.addEventListener('click', () => {
            if (!ackCb.checked) return;
            tearDownAndLogout();
        });

        setTimeout(() => ackCb.focus(), 50);
    }

    function tearDownAndLogout() {
        destroy();
        if (window.AuthManager && typeof window.AuthManager.logout === 'function') {
            try {
                const result = window.AuthManager.logout();
                if (result && typeof result.catch === 'function') result.catch(() => {});
            } catch { /* ignored */ }
        }
        if (activePromiseReject) {
            const reject = activePromiseReject;
            activePromiseResolve = null;
            activePromiseReject = null;
            reject(new Error('User cancelled session resume'));
        }
    }

    function destroy() {
        if (modalEl && modalEl.parentNode) {
            modalEl.parentNode.removeChild(modalEl);
        }
        modalEl = null;
        document.removeEventListener('keydown', handleTabTrap, true);
        document.removeEventListener('keydown', handleEscape, true);
        if (previouslyFocusedElement && typeof previouslyFocusedElement.focus === 'function') {
            try { previouslyFocusedElement.focus(); } catch { /* element gone */ }
        }
        previouslyFocusedElement = null;
    }

    function show(email) {
        if (modalEl) {
            return new Promise((resolve, reject) => {
                const prevResolve = activePromiseResolve;
                const prevReject = activePromiseReject;
                activePromiseResolve = (val) => { if (prevResolve) prevResolve(val); resolve(val); };
                activePromiseReject = (err) => { if (prevReject) prevReject(err); reject(err); };
            });
        }

        injectStyles();
        previouslyFocusedElement = document.activeElement;

        const { overlay, passwordInput } = build(email);
        modalEl = overlay;
        document.body.appendChild(overlay);

        setTimeout(() => passwordInput.focus(), 100);

        document.addEventListener('keydown', handleTabTrap, true);
        document.addEventListener('keydown', handleEscape, true);

        return new Promise((resolve, reject) => {
            activePromiseResolve = resolve;
            activePromiseReject = reject;
        });
    }

    function isOpen() { return modalEl !== null; }

    return { show, isOpen };
})();

if (typeof window !== 'undefined') {
    window.SessionLockModal = SessionLockModal;
}
