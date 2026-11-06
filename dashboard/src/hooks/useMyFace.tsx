// dashboard/src/hooks/useMyFace.tsx
// The face of the person viewing (Crie seu Luve B2, GET/PATCH /me/display: one per login). Loaded ONCE by the provider the shell
// mounts; every "you" (the person's own bubbles in conversations and rooms, Settings) reads it from here and shows the same face.
// Hermes does not record which human sent each message, so the bubble wears the face of whoever is looking, never of a named person.
// Without the provider (tests, a screen on its own) there is no face and no request. A failed read is no face, never an error screen.

import React from "react";
import type { BotAvatar } from "../api/types";
import { getMyDisplay, setMyDisplay } from "../api/client";

interface MyFace { face: BotAvatar | null; save: (avatar: BotAvatar) => Promise<void> }

const NONE: MyFace = { face: null, save: async () => { throw new Error("no MyFaceProvider"); } };
const Ctx = React.createContext<MyFace>(NONE);

export function MyFaceProvider({ children }: { children: React.ReactNode }) {
  const [face, setFace] = React.useState<BotAvatar | null>(null);
  React.useEffect(() => {
    let alive = true;
    getMyDisplay().then((r) => { if (alive) setFace(r.avatar ?? null); }).catch(() => { /* no face yet */ });
    return () => { alive = false; };
  }, []);
  const save = React.useCallback(async (avatar: BotAvatar) => { setFace((await setMyDisplay(avatar)).avatar); }, []);
  const value = React.useMemo(() => ({ face, save }), [face, save]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useMyFace = (): MyFace => React.useContext(Ctx);
