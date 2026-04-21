/**
 * Productivity Sidekick — Recovery Key Display (Shared Module)
 * ============================================================
 * Single source of truth for displaying a recovery key. Used by:
 *   - Registration success flow (main app)
 *   - Settings → Security regeneration (security-settings-panel.js)
 *
 * Each Copy/Download/Print action calls AuthManager.markRecoveryKitAcknowledged()
 * on first invocation, which persists acknowledgment to the encrypted vault
 * and suppresses the upgrade-needed toast on next login.
 */

'use strict';

const RecoveryKeyDisplay = (function() {

    let stylesInjected = false;

    const STYLES = `
        .rkd-display {
            background: var(--bg-template, #ffffff);
            border: 2px solid var(--color-primary, #6366f1);
            border-radius: var(--radius-md, 8px);
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            animation: rkd-fade-in 200ms ease-out;
        }
        @keyframes rkd-fade-in {
            from { opacity: 0; transform: translateY(-4px); }
            to   { opacity: 1; transform: translateY(0); }
        }
        .rkd-title {
            margin: 0;
            font-size: 1em;
            font-weight: 800;
            color: var(--color-text, #0f172a);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .rkd-warning {
            background: #fef2f2;
            border-left: 3px solid var(--color-danger, #ef4444);
            padding: 10px 12px;
            border-radius: 4px;
            font-size: 0.8em;
            color: #7f1d1d;
            line-height: 1.5;
            font-weight: 500;
        }
        body.dark-theme .rkd-warning { background: #2d1515; color: #fca5a5; }
        .rkd-key-value {
            font-family: var(--font-mono, monospace);
            font-size: 1em;
            background: var(--bg-home, #f8fafc);
            padding: 14px;
            border-radius: 6px;
            border: 1px solid var(--color-border, #e2e8f0);
            word-break: break-all;
            user-select: all;
            color: var(--color-text, #0f172a);
            text-align: center;
            font-weight: 700;
            letter-spacing: 0.5px;
            cursor: text;
        }
        .rkd-key-value:focus {
            outline: 2px solid var(--color-primary, #6366f1);
            outline-offset: 2px;
        }
        .rkd-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .rkd-btn {
            flex: 1; min-width: 90px;
            background: transparent;
            color: var(--color-text, #0f172a);
            border: 1px solid var(--color-border, #e2e8f0);
            padding: 9px 12px;
            border-radius: var(--radius-md, 8px);
            font-size: 0.85em;
            font-weight: 600;
            cursor: pointer;
            font-family: inherit;
            transition: all 0.15s;
        }
        .rkd-btn:hover {
            background: var(--bg-home, #f8fafc);
            border-color: var(--color-primary, #6366f1);
            color: var(--color-primary, #6366f1);
        }
        .rkd-btn:focus { outline: 2px solid var(--color-primary, #6366f1); outline-offset: 1px; }
        .rkd-done {
            margin-top: 4px;
            background: var(--color-success, #10b981);
            color: white;
            border: none;
            padding: 10px;
            border-radius: var(--radius-md, 8px);
            font-size: 0.88em;
            font-weight: 700;
            cursor: pointer;
            font-family: inherit;
            transition: background 0.15s, transform 0.15s;
        }
        .rkd-done:hover { background: #059669; transform: translateY(-1px); }
        .rkd-ack-indicator {
            font-size: 0.75em;
            color: var(--color-success, #10b981);
            font-weight: 600;
            text-align: center;
            min-height: 1.2em;
        }
    `;

    function injectStyles() {
        if (stylesInjected) return;
        const style = document.createElement('style');
        style.id = 'recovery-key-display-styles';
        style.textContent = STYLES;
        document.head.appendChild(style);
        stylesInjected = true;
    }

    async function acknowledgeOnce(state) {
        if (state.acknowledged) return;
        state.acknowledged = true;
        try {
            if (window.AuthManager && typeof window.AuthManager.markRecoveryKitAcknowledged === 'function') {
                await window.AuthManager.markRecoveryKitAcknowledged();
            }
        } catch (err) {
            console.warn('markRecoveryKitAcknowledged failed (non-fatal):', err);
        }
    }

    async function handleCopy(recoveryKey, btn, state, ackIndicator) {
        const originalText = btn.textContent;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(recoveryKey);
            } else {
                const ta = document.createElement('textarea');
                ta.value = recoveryKey;
                ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            btn.textContent = '✅ Copied';
            setTimeout(() => { btn.textContent = originalText; }, 2000);
            await acknowledgeOnce(state);
            updateAckIndicator(ackIndicator, state);
        } catch (err) {
            btn.textContent = '❌ Failed';
            setTimeout(() => { btn.textContent = originalText; }, 2000);
        }
    }

    async function handleDownload(recoveryKey, email, btn, state, ackIndicator) {
        const originalText = btn.textContent;
        try {
            const content =
                'Productivity Sidekick — Recovery Key\n' +
                '======================================\n\n' +
                `Account: ${email || '(unknown)'}\n` +
                `Generated: ${new Date().toISOString()}\n\n` +
                'RECOVERY KEY:\n' +
                `${recoveryKey}\n\n` +
                'INSTRUCTIONS:\n' +
                '  1. Store this file in a secure location (password manager,\n' +
                '     encrypted drive, or printed copy in a safe).\n' +
                '  2. Do NOT email it, upload to cloud storage, or share it.\n' +
                '  3. Anyone with this key can reset your password and access\n' +
                '     your data.\n' +
                '  4. If you suspect this key has been exposed, generate a new\n' +
                '     one immediately from Settings → Security.\n';

            const blob = new Blob([content], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `productivity-sidekick-recovery-key-${new Date().toISOString().slice(0, 10)}.txt`;
            a.click();
            URL.revokeObjectURL(a.href);

            btn.textContent = '✅ Downloaded';
            setTimeout(() => { btn.textContent = originalText; }, 2000);
            await acknowledgeOnce(state);
            updateAckIndicator(ackIndicator, state);
        } catch (err) {
            btn.textContent = '❌ Failed';
            setTimeout(() => { btn.textContent = originalText; }, 2000);
        }
    }

    async function handlePrint(recoveryKey, email, btn, state, ackIndicator) {
        const originalText = btn.textContent;
        try {
            const printHtml =
                '<!DOCTYPE html><html><head><meta charset="utf-8">' +
                '<title>Productivity Sidekick Recovery Key</title>' +
                '<style>' +
                'body { font-family: system-ui, sans-serif; padding: 40px; max-width: 600px; margin: auto; }' +
                'h1 { font-size: 18pt; border-bottom: 2px solid #333; padding-bottom: 8px; }' +
                '.key { font-family: monospace; font-size: 16pt; padding: 16px; background: #f5f5f5; '
                    + 'border: 2px solid #333; margin: 20px 0; word-break: break-all; text-align: center; }' +
                '.warning { background: #fff3cd; border-left: 4px solid #f0ad4e; padding: 12px; '
                    + 'margin: 16px 0; font-size: 10pt; }' +
                '@media print { body { padding: 20px; } }' +
                '</style></head><body>' +
                '<h1>Productivity Sidekick — Recovery Key</h1>' +
                '<p><strong>Account:</strong> ' + escapeHtml(email || '(unknown)') + '<br>' +
                '<strong>Generated:</strong> ' + escapeHtml(new Date().toLocaleString()) + '</p>' +
                '<div class="key">' + escapeHtml(recoveryKey) + '</div>' +
                '<div class="warning"><strong>KEEP THIS DOCUMENT SECURE.</strong> Anyone with this key ' +
                'can reset your password and access your data.</div>' +
                '<script>window.onload = function() { window.print(); };<\/script>' +
                '</body></html>';

            const blob = new Blob([printHtml], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const printWin = window.open(url, '_blank');
            if (!printWin) throw new Error('Pop-up blocked');
            setTimeout(() => URL.revokeObjectURL(url), 10000);

            btn.textContent = '✅ Print opened';
            setTimeout(() => { btn.textContent = originalText; }, 2500);
            await acknowledgeOnce(state);
            updateAckIndicator(ackIndicator, state);
        } catch (err) {
            btn.textContent = '❌ ' + (err.message === 'Pop-up blocked' ? 'Pop-up blocked' : 'Failed');
            setTimeout(() => { btn.textContent = originalText; }, 3000);
        }
    }

    function updateAckIndicator(indicator, state) {
        if (!indicator) return;
        if (state.acknowledged) {
            indicator.textContent = '✓ Saved — you can dismiss this display';
        }
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function render(container, options) {
        if (!container || !(container instanceof HTMLElement)) {
            throw new Error('RecoveryKeyDisplay.render: container element required');
        }
        if (!options || typeof options.recoveryKey !== 'string' || !options.recoveryKey) {
            throw new Error('RecoveryKeyDisplay.render: recoveryKey required');
        }

        injectStyles();

        const recoveryKey = options.recoveryKey;
        const email = options.email || '';
        const context = options.context || 'settings';
        const onDismiss = typeof options.onDismiss === 'function' ? options.onDismiss : () => {};

        const state = { acknowledged: false };

        while (container.firstChild) container.removeChild(container.firstChild);

        const display = document.createElement('div');
        display.className = 'rkd-display';
        display.setAttribute('role', 'region');
        display.setAttribute('aria-label', 'New recovery key');
        display.setAttribute('aria-live', 'assertive');

        const title = document.createElement('h4');
        title.className = 'rkd-title';
        const titleIcon = document.createElement('span');
        titleIcon.setAttribute('aria-hidden', 'true');
        titleIcon.textContent = '🔑';
        title.appendChild(titleIcon);
        title.appendChild(document.createTextNode(
            context === 'registration' ? 'Save Your Recovery Key' : 'Your New Recovery Key'
        ));
        display.appendChild(title);

        const warning = document.createElement('div');
        warning.className = 'rkd-warning';
        warning.textContent =
            'Save this key somewhere safe RIGHT NOW. It will not be shown again. '
            + 'Without it, you cannot recover your account if you forget your password.';
        display.appendChild(warning);

        const keyValue = document.createElement('div');
        keyValue.className = 'rkd-key-value';
        keyValue.textContent = recoveryKey;
        keyValue.setAttribute('tabindex', '0');
        keyValue.setAttribute('role', 'textbox');
        keyValue.setAttribute('aria-readonly', 'true');
        keyValue.setAttribute('aria-label', 'Recovery key, press Enter to select all');
        keyValue.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const range = document.createRange();
                range.selectNodeContents(keyValue);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        });
        display.appendChild(keyValue);

        const ackIndicator = document.createElement('div');
        ackIndicator.className = 'rkd-ack-indicator';
        ackIndicator.setAttribute('role', 'status');
        ackIndicator.setAttribute('aria-live', 'polite');
        display.appendChild(ackIndicator);

        const actions = document.createElement('div');
        actions.className = 'rkd-actions';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'rkd-btn';
        copyBtn.textContent = '📋 Copy';
        copyBtn.setAttribute('aria-label', 'Copy recovery key to clipboard');
        copyBtn.addEventListener('click', () => handleCopy(recoveryKey, copyBtn, state, ackIndicator));
        actions.appendChild(copyBtn);

        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'rkd-btn';
        downloadBtn.textContent = '💾 Download';
        downloadBtn.setAttribute('aria-label', 'Download recovery key as text file');
        downloadBtn.addEventListener('click', () => handleDownload(recoveryKey, email, downloadBtn, state, ackIndicator));
        actions.appendChild(downloadBtn);

        const printBtn = document.createElement('button');
        printBtn.type = 'button';
        printBtn.className = 'rkd-btn';
        printBtn.textContent = '🖨️ Print';
        printBtn.setAttribute('aria-label', 'Print recovery key');
        printBtn.addEventListener('click', () => handlePrint(recoveryKey, email, printBtn, state, ackIndicator));
        actions.appendChild(printBtn);

        display.appendChild(actions);

        const doneBtn = document.createElement('button');
        doneBtn.type = 'button';
        doneBtn.className = 'rkd-done';
        doneBtn.textContent = context === 'registration'
            ? "I've Saved It — Continue to App"
            : "I've Saved It — Hide Key";
        doneBtn.addEventListener('click', () => {
            try { onDismiss(); } catch (err) { console.error(err); }
        });
        display.appendChild(doneBtn);

        container.appendChild(display);

        setTimeout(() => {
            try { keyValue.focus(); } catch { /* detached */ }
        }, 100);

        return {
            dismiss: () => {
                if (display.parentNode) display.parentNode.removeChild(display);
            },
        };
    }

    return { render };
})();

if (typeof window !== 'undefined') {
    window.RecoveryKeyDisplay = RecoveryKeyDisplay;
}
