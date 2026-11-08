// dashboard/src/components/settings/MyLuve.tsx
// "Meu Luve" (Crie seu Luve U4, proposal §5 and §8 Q3): the face of the person looking, in Settings. It is the face of the LOGIN
// (PATCH /me/display, audited): the person's own bubbles in conversations and rooms wear it. A pick is a click and saves at once;
// the studio's "use" saves its recipe; an image the person sent ("Enviar imagem", contract v0.11 §2) saves the same way and "Remover imagem" goes back to the
// face before it (an image nobody wears is then offered for deletion). Nothing here names a person: Hermes does not record which human sent a message.

import React from "react";
import type { BotAvatar } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { useMyFace } from "../../hooks/useMyFace";
import { Avatar } from "../ui/Avatar";
import { LuveEntry } from "../ui/LuveStudio";
import { MascotPicker } from "../ui/MascotPicker";
import { ImageEntry } from "../ui/ImageStudio";
import { ImageLeftover } from "../ui/ImageLeftover";
import { isImageId } from "../ui/avatarImage";
import { defaultMascot } from "../ui/mascots";

export function MyLuve() {
  const { t } = useLuveI18n();
  const { face, save } = useMyFace();
  const [state, setState] = React.useState<"idle" | "saved" | "failed">("idle");
  const before = React.useRef<BotAvatar | null>(null);     // the face the person had before an image, to go back to
  const [freed, setFreed] = React.useState<string | null>(null);   // an image that just left the face, offered for deletion
  const wornImage = face?.kind === "image" && isImageId(face.value) ? face.value : null;
  const use = async (avatar: BotAvatar) => {
    try {
      await save(avatar);
      setState("saved");
      if (wornImage && !(avatar.kind === "image" && avatar.value === wornImage)) setFreed(wornImage);   // it was an image and now it is not (or another one)
    } catch { setState("failed"); }
  };
  return (
    <section aria-labelledby="settings-my-luve">
      <h2 id="settings-my-luve" className="lb-headline" style={{ margin: "24px 4px 8px" }}>{t("meLuveTitle")}</h2>
      <div className="lb-group" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {face && <Avatar name={t("summaryYou")} avatar={face} size={56} />}
          <p className="lb-caption" style={{ margin: 0, color: "var(--color-muted-foreground)" }}>{face ? t("meLuveHint") : t("meLuveNone")}</p>
        </div>
        <div><LuveEntry value={face?.kind === "luve" ? face.value : null} seedShape={face?.kind === "mascot" ? face.value : undefined}
          useLabel={t("luveUseMine")} onUse={(value) => use({ kind: "luve", value })} /></div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <ImageEntry worn={!!wornImage} useLabel={t("luveUseMine")}
            onUse={(id) => { if (face && face.kind !== "image") before.current = face; void use({ kind: "image", value: id }); }}
            onRemove={() => void use(before.current ?? { kind: "mascot", value: defaultMascot("you") })} />
        </div>
        <MascotPicker value={face?.kind === "mascot" ? face.value : null} onPick={(value) => use({ kind: "mascot", value })} />
        {freed && <ImageLeftover id={freed} onDone={() => setFreed(null)} />}
        <p role="status" className="lb-caption" style={{ margin: 0 }}>{state === "saved" ? t("meLuveSaved") : ""}</p>
        {state === "failed" && <p role="alert" className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)" }}>{t("meLuveError")}</p>}
      </div>
    </section>
  );
}
