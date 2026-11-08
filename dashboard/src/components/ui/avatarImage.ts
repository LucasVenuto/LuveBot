// dashboard/src/components/ui/avatarImage.ts
// A person's own image as a face (contract v0.11 §2.3), and the ONLY place that turns one into something a page can draw. The bytes come from GET /avatars/{id}
// through the SDK's authedFetch (an <img src> to the route would carry no session in loopback), are checked BEFORE they become a Blob (a PNG, exactly 256 x 256: what the
// server stores; anything else is refused and the face is the initials), and the resulting `blob:` URL is shared by every face that shows the same id, with a use count, and
// revoked when the last one lets go: the way ui/luve.ts does it for a Luve. A failure of any kind (no network, a 404, a 401, the wrong bytes) is the initials, as for a legacy
// `image` row: nothing here ever draws an external URL (a tracking pixel, contract v0 §14.4) or a data URI. Avatar and the Team Map call this and nothing else draws an image face.

import React from "react";
import { ApiError, getAvatarImage } from "../../api/client";
import { headerSize, sniffImage } from "../viewer/image";

export const IMAGE_ID = /^img_[0-9a-f]{32}$/;
export const AVATAR_PIXELS = 256;
/** The id the server made (`img_` and 32 lowercase hex); the display value of an image face is nothing else. */
export const isImageId = (value: unknown): value is string => typeof value === "string" && IMAGE_ID.test(value);

/** Are these the bytes of what LuveBot stores: a PNG whose header says 256 x 256. (The server re-encodes every upload itself, so this only refuses a wrong answer.) */
export function checkAvatarBytes(b: Uint8Array): boolean {
  if (sniffImage(b) !== "png") return false;
  const size = headerSize("png", b);
  return !!size && size.width === AVATAR_PIXELS && size.height === AVATAR_PIXELS;
}

interface Entry { uses: number; url: string | null; failed: boolean; started: boolean; waiters: Set<(url: string | null) => void> }
const entries = new Map<string, Entry>();

async function load(id: string, e: Entry): Promise<void> {
  e.started = true;
  let url: string | null = null;
  try {
    const bytes = await getAvatarImage(id);
    if (e.uses > 0 && checkAvatarBytes(bytes) && typeof URL.createObjectURL === "function") url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  } catch { /* any failure is the initials */ }
  if (e.uses <= 0) { if (url) URL.revokeObjectURL(url); return; }   // every face let go while it came: nothing to keep
  e.url = url;
  e.failed = url === null;
  e.waiters.forEach((w) => w(url));
  e.waiters.clear();
}

/** One face starts showing `id`; `onUrl` hears the blob: URL (at once when it is already there, null when it failed). Returns how that face lets go. */
export function acquireAvatarImage(id: string, onUrl: (url: string | null) => void): () => void {
  let e = entries.get(id);
  if (!e) { e = { uses: 0, url: null, failed: false, started: false, waiters: new Set() }; entries.set(id, e); }
  const entry = e;
  entry.uses++;
  if (entry.url || entry.failed) onUrl(entry.url);
  else { entry.waiters.add(onUrl); if (!entry.started) void load(id, entry); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.waiters.delete(onUrl);
    if (--entry.uses > 0) return;
    if (entry.url) URL.revokeObjectURL(entry.url);
    if (entries.get(id) === entry) entries.delete(id);
  };
}

/** For tests: how many image ids are held right now. */
export const liveAvatarImages = () => entries.size;

/** A face's image URL for as long as the face is on screen: null until it is there, and for anything that is not a valid id or could not be read (the caller draws the initials). */
export function useImageSrc(id: string | null | undefined): string | null {
  const [src, setSrc] = React.useState<string | null>(null);
  React.useEffect(() => {
    setSrc(null);
    if (!isImageId(id)) return;
    return acquireAvatarImage(id, setSrc);
  }, [id]);
  return src;
}

// Does the backend this screen talks to have the avatar routes at all (contract v0.11 §2.2)? One read of an id that cannot exist: a plugin that has the route answers with
// its own envelope (a 404 or a 401, whatever), one that does not answers the dashboard's catch-all, which the client calls `plugin_route_missing`. Without the routes the
// "Enviar imagem" entry is not shown (nothing to click that could only fail). Remembered for the page; a network failure is not remembered (the next screen asks again).
const PROBE_ID = "img_" + "0".repeat(32);
let probe: Promise<boolean> | null = null;
export function avatarImagesAvailable(): Promise<boolean> {
  probe ??= getAvatarImage(PROBE_ID).then(() => true, (e: unknown) => {
    if (e instanceof ApiError && e.code !== "plugin_route_missing" && e.code !== "sdk_unavailable" && e.code !== "luvebot_needs_in_process") return true;
    if (e instanceof ApiError) return false;      // the routes are not there: that is an answer
    probe = null; return false;                    // the network: ask again next time
  });
  return probe;
}
/** For tests: forget what the probe learned. */
export const forgetAvatarProbe = () => { probe = null; };

export function useAvatarImagesAvailable(): boolean {
  const [ok, setOk] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void avatarImagesAvailable().then((v) => { if (alive) setOk(v); });
    return () => { alive = false; };
  }, []);
  return ok;
}
