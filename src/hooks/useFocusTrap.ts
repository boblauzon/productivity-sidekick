// ─── useFocusTrap ──────────────────────────────────────────────────────────────
// Accessibility primitive used by every overlay surface (drawer, modal,
// popover). Behaviours guaranteed when active:
//
//   1. Focus is moved into the container on activation (configurable element).
//   2. Tab / Shift+Tab cycle within the container — focus cannot escape.
//   3. Escape calls the supplied onEscape (typically the close handler).
//   4. The element that had focus before activation is restored on cleanup.
//
// Why a hand-rolled trap instead of a library:
//   • Zero dependencies — every npm package added to a security-sensitive
//     surface is another supply-chain risk we'd need to audit.
//   • The semantics here are deliberately small and easy to reason about.
//
// Limitations (intentional):
//   • Does not crawl shadow DOM. None of our overlays use shadow DOM.
//   • Does not track DOM mutations within the container. If your overlay
//     dynamically adds focusable content, call `recompute()` from the
//     returned API after the mutation settles.

import { useCallback, useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'audio[controls]',
  'video[controls]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(',');

export interface UseFocusTrapOptions {
  active: boolean;
  onEscape?: () => void;
  /** Element to focus on activation. Defaults to the container itself. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Set false if a parent already restores focus (rare). */
  restoreFocus?: boolean;
}

export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  { active, onEscape, initialFocusRef, restoreFocus = true }: UseFocusTrapOptions,
) {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const getFocusable = useCallback((): HTMLElement[] => {
    const root = containerRef.current;
    if (!root) return [];
    const nodes = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    // Filter out anything that is rendered but not actually visible
    // (display:none, hidden attribute, zero-size). offsetParent is a cheap proxy.
    return Array.from(nodes).filter((n) =>
      !n.hasAttribute('hidden') &&
      !(n.getAttribute('aria-hidden') === 'true') &&
      (n.offsetWidth > 0 || n.offsetHeight > 0 || n === document.activeElement)
    );
  }, [containerRef]);

  useEffect(() => {
    if (!active) return;

    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null;

    // Initial focus: explicit ref → first focusable → container itself.
    const target =
      initialFocusRef?.current ??
      getFocusable()[0] ??
      containerRef.current;
    target?.focus({ preventScroll: false });

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // Don't preventDefault unconditionally — some inputs use Escape to
        // clear themselves, and we want that to win when typing.
        if (onEscape) {
          e.stopPropagation();
          onEscape();
        }
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        e.preventDefault();
        containerRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;

      if (e.shiftKey && (activeEl === first || !containerRef.current?.contains(activeEl))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }

    function handleFocusIn(e: FocusEvent) {
      // Containment guard: if focus moved outside the container (e.g. via
      // programmatic focus from elsewhere), pull it back.
      const root = containerRef.current;
      if (!root) return;
      const target = e.target as Node;
      if (!root.contains(target)) {
        const focusable = getFocusable();
        (focusable[0] ?? root).focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      if (restoreFocus && previouslyFocused.current && document.contains(previouslyFocused.current)) {
        previouslyFocused.current.focus({ preventScroll: true });
      }
      previouslyFocused.current = null;
    };
  }, [active, onEscape, getFocusable, containerRef, initialFocusRef, restoreFocus]);

  return { recompute: getFocusable };
}
