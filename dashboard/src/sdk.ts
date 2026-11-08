// dashboard/src/sdk.ts
// Typed access to window.__HERMES_PLUGIN_SDK__ and window.__HERMES_PLUGINS__

export interface HermesPluginSDK {
  sdkVersion: string;
  React: typeof import("react");
  hooks: {
    useState: typeof import("react").useState;
    useEffect: typeof import("react").useEffect;
    useCallback: typeof import("react").useCallback;
    useMemo: typeof import("react").useMemo;
    useRef: typeof import("react").useRef;
    useContext: typeof import("react").useContext;
    createContext: typeof import("react").createContext;
    useToast: () => {
      showToast: (message: string, type: "success" | "error") => void;
      toast: { message: string; type: "success" | "error" } | null;
    };
    useConfirmDelete: <TId>(opts: {
      onDelete: (id: TId) => Promise<void>;
    }) => {
      requestDelete: (id: TId) => void;
      confirm: () => Promise<void>;
      cancel: () => void;
      isOpen: boolean;
      isDeleting: boolean;
      pendingId: TId | null;
    };
  };
  api: Record<string, (...args: any[]) => any>;
  fetchJSON: <T = unknown>(
    url: string,
    init?: RequestInit,
    options?: { allowUnauthorized?: boolean }
  ) => Promise<T>;
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  buildWsUrl: (path: string, params?: Record<string, string>) => Promise<string>;
  buildWsAuthParam: () => Promise<[string, string]>;
  components: Record<string, React.ComponentType<any>>;
  utils: {
    cn: (...classes: Array<string | false | null | undefined>) => string;
    timeAgo: (ts: number) => string;
    isoTimeAgo: (iso: string) => string;
  };
  useI18n: () => {
    locale?: string;
    t?: (key: string) => string;
  };
}

export interface PluginRegistry {
  register(name: string, component: React.ComponentType<any>): void;
  registerSlot?(plugin: string, slot: string, component: React.ComponentType<any>): void;  // web/src/plugins/slots.ts registerSlot
}

declare global {
  interface Window {
    __HERMES_PLUGIN_SDK__?: HermesPluginSDK;
    __HERMES_PLUGINS__?: PluginRegistry;
  }
}

const OURS = "/api/plugins/luvebot";

/** ADR-006 D1: a call to OUR plugin API says `profile=current` ("the dashboard's own profile"), so the Hermes dashboard's profile
 *  selector (which it appends to every /api/plugins/* call when none is given) can never send us to another profile's plugin host:
 *  an explicit `profile=` wins there. Anything that is not ours, or already carries a `profile=`, is left exactly as it came. */
function pin(url: unknown): unknown {
  if (typeof url !== "string") return url;
  let u: URL;
  try { u = new URL(url, window.location.origin); } catch { return url; }
  if (u.origin !== window.location.origin || (u.pathname !== OURS && !u.pathname.startsWith(OURS + "/")) || u.searchParams.has("profile")) return url;
  // appended as text: the rest of the URL (its encoding included) goes exactly as it came
  const at = url.indexOf("#");
  const base = at < 0 ? url : url.slice(0, at);
  return base + (/[?&]$/.test(base) ? "" : base.includes("?") ? "&" : "?") + "profile=current" + (at < 0 ? "" : url.slice(at));
}

// one wrapper per SDK object, so getSDK() keeps the same identity for the same SDK
const wrapped = new WeakMap<HermesPluginSDK, HermesPluginSDK>();

export function getSDK(): HermesPluginSDK | undefined {
  if (typeof window === "undefined") return undefined;
  const sdk = window.__HERMES_PLUGIN_SDK__;
  if (!sdk) return undefined;
  let out = wrapped.get(sdk);
  if (!out) {
    out = { ...sdk };
    if (sdk.fetchJSON) out.fetchJSON = ((url, init, options) => sdk.fetchJSON(pin(url) as string, init, options)) as HermesPluginSDK["fetchJSON"];
    if (sdk.authedFetch) out.authedFetch = (url, init) => sdk.authedFetch(pin(url) as string, init);
    wrapped.set(sdk, out);
  }
  return out;
}

export function getPluginRegistry(): PluginRegistry | undefined {
  if (typeof window !== "undefined") {
    return window.__HERMES_PLUGINS__;
  }
  return undefined;
}
