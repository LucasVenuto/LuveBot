// dashboard/src/shims/react-jsx-runtime.ts
// Resolves JSX transformation through window.__HERMES_PLUGIN_SDK__.React (never bundled).

const getSDK = () => {
  if (typeof window !== "undefined" && window.__HERMES_PLUGIN_SDK__) {
    return window.__HERMES_PLUGIN_SDK__;
  }
  return undefined;
};

const getReact = () =>
  getSDK()?.React ||
  (typeof globalThis !== "undefined" ? (globalThis as any).React : undefined);

export function jsx(type: any, props: any, key?: any) {
  const React = getReact();
  if (!React) {
    throw new Error("[LuveBot] Hermes Plugin SDK React is not loaded on window.__HERMES_PLUGIN_SDK__");
  }
  const { children, ...rest } = props || {};
  if (key !== undefined) {
    rest.key = key;
  }
  return React.createElement(type, rest, children);
}

export function jsxs(type: any, props: any, key?: any) {
  return jsx(type, props, key);
}

export const Fragment = (getReact()?.Fragment ||
  Symbol.for("react.fragment")) as any;
