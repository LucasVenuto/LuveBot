// dashboard/src/hooks/useFocusTrap.ts
// Reusable, zero-dependency focus trap hook for accessible modal dialogs and drawers (WCAG 2.1).
// Features:
// 1. Traps Tab and Shift-Tab inside the modal container.
// 2. Escape key closes the modal (calls onClose).
// 3. Focuses the first interactive element upon opening.
// 4. Restores focus to the triggering element upon closing.

import { useEffect, useRef } from "react";

export interface UseFocusTrapOptions {
  isOpen: boolean;
  onClose?: () => void;
  disableTrap?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

export const FOCUSABLE_ELEMENTS_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export function useFocusTrap<T extends HTMLElement = HTMLDivElement>({
  isOpen,
  onClose,
  disableTrap = false,
  initialFocusRef,
}: UseFocusTrapOptions) {
  const containerRef = useRef<T | null>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      // Restore focus to trigger element when modal closes
      if (triggerElementRef.current && typeof triggerElementRef.current.focus === "function") {
        triggerElementRef.current.focus();
      }
      return;
    }

    // Capture the element that was focused before opening the modal
    if (document.activeElement instanceof HTMLElement) {
      triggerElementRef.current = document.activeElement;
    }

    const container = containerRef.current;
    if (container) {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
      } else {
        const focusables = Array.from(
          container.querySelectorAll<HTMLElement>(FOCUSABLE_ELEMENTS_SELECTOR)
        );
        if (focusables.length > 0) {
          focusables[0].focus();
        } else {
          container.focus();
        }
      }
    }

    if (disableTrap) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. Close on Escape
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
        return;
      }

      // 2. Trap Tab navigation
      if (e.key === "Tab") {
        const currentContainer = containerRef.current;
        if (!currentContainer) return;

        const focusables = Array.from(
          currentContainer.querySelectorAll<HTMLElement>(FOCUSABLE_ELEMENTS_SELECTOR)
        ).filter(
          (el) =>
            !el.hasAttribute("disabled") &&
            el.getAttribute("tabindex") !== "-1"
        );

        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusables[0];
        const lastElement = focusables[focusables.length - 1];

        if (e.shiftKey) {
          // Shift + Tab: if on first element, wrap around to last
          if (
            document.activeElement === firstElement ||
            !currentContainer.contains(document.activeElement)
          ) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          // Tab: if on last element, wrap around to first
          if (
            document.activeElement === lastElement ||
            !currentContainer.contains(document.activeElement)
          ) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, disableTrap, initialFocusRef]);

  return containerRef;
}
