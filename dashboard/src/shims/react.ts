// dashboard/src/shims/react.ts
// Resolves React and React hooks from window.__HERMES_PLUGIN_SDK__.React (never bundled).

const getSDK = () => {
  if (typeof window !== "undefined" && window.__HERMES_PLUGIN_SDK__) {
    return window.__HERMES_PLUGIN_SDK__;
  }
  return undefined;
};

const getReact = () =>
  getSDK()?.React ||
  (typeof globalThis !== "undefined" ? (globalThis as any).React : undefined);

const React = getReact();

export default React;

export const useState = ((...args: any[]) => {
  const r = getReact();
  return (r?.useState || getSDK()?.hooks?.useState)(...args);
}) as typeof import("react").useState;

export const useEffect = ((...args: any[]) => {
  const r = getReact();
  return (r?.useEffect || getSDK()?.hooks?.useEffect)(...args);
}) as typeof import("react").useEffect;

export const useCallback = ((...args: any[]) => {
  const r = getReact();
  return (r?.useCallback || getSDK()?.hooks?.useCallback)(...args);
}) as typeof import("react").useCallback;

export const useMemo = ((...args: any[]) => {
  const r = getReact();
  return (r?.useMemo || getSDK()?.hooks?.useMemo)(...args);
}) as typeof import("react").useMemo;

export const useRef = ((...args: any[]) => {
  const r = getReact();
  return (r?.useRef || getSDK()?.hooks?.useRef)(...args);
}) as typeof import("react").useRef;

export const useContext = ((...args: any[]) => {
  const r = getReact();
  return (r?.useContext || getSDK()?.hooks?.useContext)(...args);
}) as typeof import("react").useContext;

export const createContext = ((...args: any[]) => {
  const r = getReact();
  return (r?.createContext || getSDK()?.hooks?.createContext)(...args);
}) as typeof import("react").createContext;

export const createElement = ((...args: any[]) => {
  const r = getReact();
  return r?.createElement(...args);
}) as typeof import("react").createElement;

export const Fragment = (getReact()?.Fragment ||
  Symbol.for("react.fragment")) as typeof import("react").Fragment;
