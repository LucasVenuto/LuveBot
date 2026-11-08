// dashboard/src/host/overlay.tsx
// Full screen through the supported Hermes extension point (D-023 as revised in T11.0): the `overlay` slot, "a
// fixed-position layer above everything else" (website/docs/.../extending-the-dashboard.md, rendered at
// web/src/App.tsx#L831 of f8489405). Nothing of the Hermes frame is restyled.
// * The route: the page registered for `tab.override: "/"` is only a marker. Hermes's own router mounts it when
//   "/" is active and unmounts it when the user goes to a Hermes page, so the router stays the single truth.
// * The overlay renders LuveBot only while that marker is mounted. While open, the Hermes shell under it is
//   `inert` and `aria-hidden` (out of the tab order and the accessibility tree, so focus stays in LuveBot); on close
//   exactly the attributes it set are removed.

import React from "react";

let routeActive = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => routeActive > 0;

/** Registered as the plugin page for "/": marks the LuveBot route as active while Hermes shows it. */
export function LuveBotRoute() {
  React.useLayoutEffect(() => {
    routeActive += 1; notify();
    return () => { routeActive -= 1; notify(); };
  }, []);
  return null;
}

export function useLuveBotRoute(): boolean {
  return React.useSyncExternalStore(subscribe, snapshot, () => false);
}

/** Makes every sibling of `el` inert and hidden from assistive tech, including siblings Hermes mounts later
 *  (banners). Returns the undo, which only removes what it added. */
export function isolate(el: HTMLElement): () => void {
  const parent = el.parentElement;
  if (!parent) return () => {};
  const touched = new Map<Element, { inert: boolean; hidden: boolean }>();
  const mark = (node: Element) => {
    if (node === el || touched.has(node)) return;
    const record = { inert: !node.hasAttribute("inert"), hidden: !node.hasAttribute("aria-hidden") };
    if (record.inert) node.setAttribute("inert", "");
    if (record.hidden) node.setAttribute("aria-hidden", "true");
    touched.set(node, record);
  };
  Array.from(parent.children).forEach(mark);
  const mo = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => n instanceof Element && mark(n))));
  mo.observe(parent, { childList: true });
  return () => {
    mo.disconnect();
    touched.forEach((record, node) => {
      if (record.inert) node.removeAttribute("inert");
      if (record.hidden) node.removeAttribute("aria-hidden");
    });
  };
}

/** The `overlay` slot content: nothing outside the LuveBot route; the whole app, full screen, on it. */
export function LuveBotOverlay({ children }: { children: React.ReactNode }) {
  const open = useLuveBotRoute();
  return open ? <OpenOverlay>{children}</OpenOverlay> : null;
}

function OpenOverlay({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const el = ref.current!;
    const undo = isolate(el);
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });  // focus starts inside LuveBot
    return undo;
  }, []);
  return <div ref={ref} className="lb-overlay" tabIndex={-1}>{children}</div>;
}
