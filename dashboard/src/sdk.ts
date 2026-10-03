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

export function getSDK(): HermesPluginSDK | undefined {
  if (typeof window !== "undefined") {
    return window.__HERMES_PLUGIN_SDK__;
  }
  return undefined;
}

export function getPluginRegistry(): PluginRegistry | undefined {
  if (typeof window !== "undefined") {
    return window.__HERMES_PLUGINS__;
  }
  return undefined;
}
