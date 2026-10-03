import React from "react";

// Mock the Hermes Plugin SDK on window
const mockSDK = {
  sdkVersion: "1.0.0",
  React,
  hooks: {
    useState: React.useState,
    useEffect: React.useEffect,
    useCallback: React.useCallback,
    useMemo: React.useMemo,
    useRef: React.useRef,
    useContext: React.useContext,
    createContext: React.createContext,
    useToast: () => ({ showToast: () => {}, toast: null }),
    useConfirmDelete: () => ({
      requestDelete: () => {},
      confirm: async () => {},
      cancel: () => {},
      isOpen: false,
      isDeleting: false,
      pendingId: null,
    }),
  },
  api: {},
  fetchJSON: async () => ({}),
  authedFetch: async () => new Response("ok"),
  buildWsUrl: async (path: string) => `ws://localhost:9119${path}`,
  buildWsAuthParam: async () => ["ticket", "mock-ticket"] as [string, string],
  components: {},
  utils: {
    cn: (...classes: Array<string | false | null | undefined>) =>
      classes.filter(Boolean).join(" "),
    timeAgo: (_ts: number) => "agora",
    isoTimeAgo: (_iso: string) => "agora",
  },
  useI18n: () => ({
    locale: "pt",
    t: (key: string) => key,
  }),
};

const mockPlugins = {
  _registry: new Map<string, React.ComponentType<any>>(),
  register(name: string, component: React.ComponentType<any>) {
    this._registry.set(name, component);
  },
  registerSlot(_slot: string, _name: string, _component: React.ComponentType<any>) {},
};

Object.defineProperty(window, "__HERMES_PLUGIN_SDK__", {
  value: mockSDK,
  writable: true,
  configurable: true,
});

Object.defineProperty(window, "__HERMES_PLUGINS__", {
  value: mockPlugins,
  writable: true,
  configurable: true,
});

Object.defineProperty(window.navigator, "languages", {
  value: ["pt-BR", "pt"],
  configurable: true,
});

Object.defineProperty(window.navigator, "language", {
  value: "pt-BR",
  configurable: true,
});

// Polyfill localStorage in test environment
const createStorageMock = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
};

const storageMock = createStorageMock();
Object.defineProperty(window, "localStorage", {
  value: storageMock,
  writable: true,
  configurable: true,
});
if (typeof globalThis !== "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: storageMock,
    writable: true,
    configurable: true,
  });
}

