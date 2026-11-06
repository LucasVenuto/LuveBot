// dashboard/src/whatsnew/WhatsNewScreen.tsx
// "Novidades" (docs/contracts/whats-new-v0.md section 2): what entered each version and where to find it. Versions newest first, the newest open and the older ones in a native `details`, each saying
// in words whether it is released. An item: its title, ONE sentence, "Onde achar", the optional note, "Abrir" only when it names a whole tab, and the tag "novo" while this device has not seen it.
// The words of an item are OUR static text, drawn as React text: never Markdown, never HTML. The tags stay for the whole visit; the screen marks them seen when the person LEAVES it (unmount).
import React from "react";
import { useLuveI18n } from "../i18n";
import { Avatar } from "../components/ui/Avatar";
import { versionOrder } from "./useNews";
import type { NewsItem, NewsVersionInfo } from "./types";

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-03" -> "3/10/2026" (pt) or "3 Oct 2026" (en). By hand: no time zone can move the day, and the two forms are the ones of the contract. */
export function newsDate(iso: string, locale: "pt" | "en"): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [y, mo, d] = [m[1], parseInt(m[2], 10), parseInt(m[3], 10)];
  return locale === "en" ? `${d} ${MONTHS_EN[mo - 1] ?? m[2]} ${y}` : `${d}/${mo}/${y}`;
}

export interface WhatsNewScreenProps {
  items: readonly NewsItem[];
  versions: readonly NewsVersionInfo[];
  isNew: (id: string) => boolean;
  /** a whole tab of the shell, the way the rail changes tab */
  onOpenTab: (tab: string) => void;
  /** the person left the screen: what it showed is seen */
  onLeave: () => void;
}

export function WhatsNewScreen({ items, versions, isNew, onOpenTab, onLeave }: WhatsNewScreenProps) {
  const { t, locale } = useLuveI18n();
  const lang: "pt" | "en" = locale === "en" ? "en" : "pt";
  const leave = React.useRef(onLeave); leave.current = onLeave;
  React.useEffect(() => () => leave.current(), []);

  const groups = [...versions].sort((a, b) => versionOrder(a.version, b.version))
    .map((v) => ({ info: v, items: items.filter((i) => i.since === v.version) }))
    .filter((g) => g.items.length > 0);

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "20px 16px 40px", minWidth: 0 }}>
        <header style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Avatar name="Luvi" avatar={{ kind: "mascot", value: "luvi" }} size={56} />
          <div style={{ minWidth: 0 }}>
            <h1 className="lb-title" style={{ margin: 0 }}>{t("newsTitle")}</h1>
            <p className="lb-subhead" style={{ margin: "4px 0 0" }}>{t("newsGreeting")}</p>
          </div>
        </header>

        {groups.length === 0 ? (
          <p role="status" className="lb-group lb-subhead" style={{ padding: "14px 16px", margin: "16px 0" }}>{t("newsEmpty")}</p>
        ) : groups.map((g, index) => (
          <details key={g.info.version} open={index === 0} style={{ margin: "18px 0 0" }}>
            <summary style={{ cursor: "pointer", padding: "6px 0" }}>   {/* the native triangle stays (no display:flex): it is what tells a person that a closed version opens */}
              <h2 className="lb-headline" style={{ display: "inline", margin: 0 }}>{g.info.version}</h2>
              <span className="lb-caption" style={{ marginLeft: 10 }}>
                {g.info.status === "released" && g.info.date ? t("newsReleasedOn", { date: newsDate(g.info.date, lang) }) : t("newsUnreleased")}
              </span>
            </summary>
            <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
              {g.items.map((item) => (
                <li key={item.id} className="lb-group" style={{ padding: "12px 16px", overflowWrap: "anywhere" }}>
                  <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <h3 className="lb-headline" style={{ margin: 0, minWidth: 0 }}>{item.title[lang]}</h3>
                    {isNew(item.id) && <span className="lb-pill" style={{ color: "var(--color-primary)" }}>{t("newsTag")}</span>}
                  </div>
                  <p className="lb-subhead" style={{ margin: "4px 0 0" }}>{item.what[lang]}</p>
                  <p className="lb-caption" style={{ margin: "6px 0 0" }}>
                    <span style={{ fontWeight: 600 }}>{t("newsWhere")}</span>{": "}{item.where[lang]}
                  </p>
                  {item.note && <p className="lb-caption" style={{ margin: "4px 0 0" }}>{item.note[lang]}</p>}
                  {item.go && (
                    <button type="button" className="lb-btn" style={{ marginTop: 10 }} aria-label={t("newsOpenItem", { title: item.title[lang] })}
                      onClick={() => onOpenTab(item.go as string)}>{t("newsOpen")}</button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}
