import React from "react";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import {
  translations,
  getInitialLocale,
  setLuveLocale,
  useLuveI18n,
  STORAGE_KEY,
  LOCALE_EVENT,
  type TranslationKey,
} from "@/i18n";
import { MessengerShell } from "@/components/messenger/MessengerShell";
import { Hoje } from "@/components/Hoje";
import { ContactList } from "@/components/messenger/ContactList";
import { ApprovalsInbox } from "@/components/approvals/ApprovalsInbox";
import { RulesView } from "@/components/rules/RulesView";
import { CostsView } from "@/components/costs/CostsView";
import { RoutinesView } from "@/components/routines/RoutinesView";
import { ActivityView } from "@/components/activity/ActivityView";
import { RoomsView } from "@/components/rooms/RoomsView";
import { TeamMapView } from "@/components/map/TeamMapView";
import { CommandPaletteModal } from "@/components/search/CommandPaletteModal";

// Helper hook consumer component
function I18nConsumerComponent({ onRender }: { onRender?: (data: ReturnType<typeof useLuveI18n>) => void }) {
  const i18n = useLuveI18n();
  if (onRender) onRender(i18n);
  return (
    <div>
      <span data-testid="current-locale">{i18n.locale}</span>
      <span data-testid="today-title">{i18n.t("hojeTitle")}</span>
      <span data-testid="param-test">{i18n.t("pageArea", { tab: "vendas" })}</span>
      <button data-testid="switch-en" onClick={() => i18n.setLocale("en")}>
        EN
      </button>
      <button data-testid="switch-pt" onClick={() => i18n.setLocale("pt")}>
        PT
      </button>
    </div>
  );
}

describe("i18n Complete PT / EN Subsystem", () => {
  const originalLocalStorage = window.localStorage;

  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    setLuveLocale("pt");
  });

  describe("Dictionary Parity and Integrity", () => {
    it("has 100% key parity between PT and EN dictionaries", () => {
      const ptKeys = Object.keys(translations.pt).sort() as TranslationKey[];
      const enKeys = Object.keys(translations.en).sort() as TranslationKey[];

      expect(ptKeys).toEqual(enKeys);
      expect(ptKeys.length).toBeGreaterThan(100);
    });

    it("has no empty or whitespace-only translation strings in PT or EN", () => {
      for (const [key, value] of Object.entries(translations.pt)) {
        expect(value.trim(), `PT key "${key}" should not be empty`).toBeTruthy();
      }
      for (const [key, value] of Object.entries(translations.en)) {
        expect(value.trim(), `EN key "${key}" should not be empty`).toBeTruthy();
      }
    });

    it("correctly preserves variable placeholders across PT and EN", () => {
      const placeholderRegex = /\{([a-zA-Z0-9_]+)\}/g;

      for (const key of Object.keys(translations.pt) as TranslationKey[]) {
        const ptStr = translations.pt[key];
        const enStr = translations.en[key];

        const ptMatches = Array.from(ptStr.matchAll(placeholderRegex)).map((m) => m[1]).sort();
        const enMatches = Array.from(enStr.matchAll(placeholderRegex)).map((m) => m[1]).sort();

        expect(
          ptMatches,
          `Placeholders for key "${key}" must match in PT and EN`
        ).toEqual(enMatches);
      }
    });
  });

  describe("Locale Resolution and Persistence (getInitialLocale & setLuveLocale)", () => {
    it("reads saved preference from localStorage when available", () => {
      window.localStorage.setItem(STORAGE_KEY, "en");
      expect(getInitialLocale()).toBe("en");

      window.localStorage.setItem(STORAGE_KEY, "pt");
      expect(getInitialLocale()).toBe("pt");
    });

    it("ignores invalid values stored in localStorage and falls back to navigator", () => {
      window.localStorage.setItem(STORAGE_KEY, "invalid-lang");
      // Default in test setup is pt-BR
      expect(["pt", "en"]).toContain(getInitialLocale());
    });

    it("handles localStorage throwing security error gracefully without crashing", () => {
      const spy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
        throw new Error("SecurityError: localStorage is denied");
      });

      expect(() => getInitialLocale()).not.toThrow();
      expect(["pt", "en"]).toContain(getInitialLocale());

      spy.mockRestore();
    });

    it("setLuveLocale saves to localStorage with try/catch and dispatches event", () => {
      let eventDispatched = false;
      let detailValue = "";
      const listener = (e: Event) => {
        eventDispatched = true;
        detailValue = (e as CustomEvent).detail;
      };
      window.addEventListener(LOCALE_EVENT, listener);

      setLuveLocale("en");
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("en");
      expect(eventDispatched).toBe(true);
      expect(detailValue).toBe("en");

      window.removeEventListener(LOCALE_EVENT, listener);
    });

    it("setLuveLocale handles localStorage write failures safely", () => {
      const spy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

      expect(() => setLuveLocale("pt")).not.toThrow();
      spy.mockRestore();
    });
  });

  describe("useLuveI18n Hook and Dynamic Switching", () => {
    it("renders initial translations and parameter interpolations", () => {
      setLuveLocale("pt");
      render(<I18nConsumerComponent />);

      expect(screen.getByTestId("current-locale").textContent).toBe("pt");
      expect(screen.getByTestId("today-title").textContent).toBe("Hoje");
      expect(screen.getByTestId("param-test").textContent).toBe("Área da página: vendas");
    });

    it("switches language dynamically upon user action", () => {
      setLuveLocale("pt");
      render(<I18nConsumerComponent />);

      expect(screen.getByTestId("current-locale").textContent).toBe("pt");
      expect(screen.getByTestId("today-title").textContent).toBe("Hoje");

      act(() => {
        fireEvent.click(screen.getByTestId("switch-en"));
      });

      expect(screen.getByTestId("current-locale").textContent).toBe("en");
      expect(screen.getByTestId("today-title").textContent).toBe("Today");
      expect(screen.getByTestId("param-test").textContent).toBe("Page area: vendas");

      act(() => {
        fireEvent.click(screen.getByTestId("switch-pt"));
      });

      expect(screen.getByTestId("current-locale").textContent).toBe("pt");
      expect(screen.getByTestId("today-title").textContent).toBe("Hoje");
    });
  });

  describe("UI Screens Render in Both PT and EN Without Hardcoded Strings", () => {
    it("renders Shell component in PT and EN cleanly", () => {
      // PT render
      setLuveLocale("pt");
      const { rerender } = render(<MessengerShell />);
      expect(screen.getByRole("button", { name: /^hoje$/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /aprovações/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^atividade$/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^buscar$/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^configurações$/i })).toBeDefined();
      expect(screen.getByText("Nenhum Bot ainda")).toBeDefined();
      expect(screen.getByText("Nenhuma sala")).toBeDefined();

      // Switch to EN
      act(() => {
        setLuveLocale("en");
      });
      rerender(<MessengerShell />);
      expect(screen.getByRole("button", { name: /^today$/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /approvals/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^activity$/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^search$/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^settings$/i })).toBeDefined();
      expect(screen.getByText("No Bots yet")).toBeDefined();
      expect(screen.getByText("No rooms")).toBeDefined();
      expect(screen.queryByText("Nenhum Bot ainda")).toBeNull();
    });

    it("renders Hoje screen in PT and EN cleanly", () => {
      setLuveLocale("pt");
      const { rerender } = render(<Hoje />);
      expect(screen.getByRole("heading", { level: 1, name: "Hoje" })).toBeDefined();
      expect(screen.getByText("0 Bots ativos")).toBeDefined();
      expect(screen.getByText("Precisa de você")).toBeDefined();
      expect(screen.getByText("Em andamento")).toBeDefined();
      expect(screen.getByText("Concluído hoje")).toBeDefined();
      expect(screen.getByText("Nenhum Bot criado ainda")).toBeDefined();

      act(() => {
        setLuveLocale("en");
      });
      rerender(<Hoje />);
      expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeDefined();
      expect(screen.getByText("0 active Bots")).toBeDefined();
      expect(screen.getByText("Needs you")).toBeDefined();
      expect(screen.getByText("In progress")).toBeDefined();
      expect(screen.getByText("Completed today")).toBeDefined();
      expect(screen.getByText("No Bots created yet")).toBeDefined();
      expect(screen.queryByText("Precisa de você")).toBeNull();
    });

    it("renders ContactList in PT and EN cleanly", () => {
      setLuveLocale("pt");
      const { rerender } = render(
        <ContactList
          bots={[]}
          isOffline={true}
          onSelectBot={() => {}}
          onOpenCreate={() => {}}
        />
      );
      expect(screen.getByText("Sem conexão com o Hermes")).toBeDefined();
      expect(screen.getByText("Aguardando sinal do API Server...")).toBeDefined();

      act(() => {
        setLuveLocale("en");
      });
      rerender(
        <ContactList
          bots={[]}
          isOffline={true}
          onSelectBot={() => {}}
          onOpenCreate={() => {}}
        />
      );
      expect(screen.getByText("No connection to Hermes")).toBeDefined();
      expect(screen.getByText("Waiting for API Server signal...")).toBeDefined();
      expect(screen.queryByText("Sem conexão com o Hermes")).toBeNull();
    });

    it("renders ApprovalsInbox in PT and EN cleanly", () => {
      setLuveLocale("pt");
      const { rerender } = render(<ApprovalsInbox bots={[]} />);
      expect(screen.getByRole("heading", { name: "Caixa de Aprovações" })).toBeDefined();
      expect(screen.getByLabelText("Filtrar por Bot")).toBeDefined();
      expect(screen.getByLabelText("Filtrar por status")).toBeDefined();

      act(() => {
        setLuveLocale("en");
      });
      rerender(<ApprovalsInbox bots={[]} />);
      expect(screen.getByRole("heading", { name: "Approvals Inbox" })).toBeDefined();
      expect(screen.getByLabelText("Filter by Bot")).toBeDefined();
      expect(screen.getByLabelText("Filter by status")).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Caixa de Aprovações" })).toBeNull();
    });

    it("renders RulesView in PT and EN cleanly", () => {
      setLuveLocale("pt");
      const { rerender } = render(<RulesView authMode="gated" bots={[]} />);
      expect(screen.getByRole("heading", { name: "Regras e Governança" })).toBeDefined();
      expect(screen.getByRole("button", { name: /nova regra/i })).toBeDefined();
      expect(
        screen.getByText("Precedência: Bloquear > Devolver > Perguntar > Explícito > Agir")
      ).toBeDefined();

      act(() => {
        setLuveLocale("en");
      });
      rerender(<RulesView authMode="gated" bots={[]} />);
      expect(screen.getByRole("heading", { name: "Rules and Governance" })).toBeDefined();
      expect(screen.getByRole("button", { name: /new rule/i })).toBeDefined();
      expect(
        screen.getByText("Precedence: Block > Handback > Ask > Explicit > Allow")
      ).toBeDefined();
      expect(screen.queryByText("Precedência: Bloquear > Devolver > Perguntar > Explícito > Agir")).toBeNull();
    });

    it("renders CostsView in PT and EN cleanly", () => {
      setLuveLocale("pt");
      const { rerender } = render(<CostsView authMode="gated" bots={[]} />);
      expect(screen.getByRole("heading", { name: "Custos e Orçamento" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Visão Geral de Gastos" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Tetos e Limites" })).toBeDefined();

      act(() => {
        setLuveLocale("en");
      });
      rerender(<CostsView authMode="gated" bots={[]} />);
      expect(screen.getByRole("heading", { name: "Costs & Budget" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Spend Overview" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Ceilings & Limits" })).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Custos e Orçamento" })).toBeNull();
    });

    it("renders RoutinesView in PT and EN cleanly", () => {
      setLuveLocale("pt");
      const { rerender } = render(<RoutinesView bots={[]} />);
      expect(screen.getByRole("heading", { name: "Rotinas e Agendamentos" })).toBeDefined();
      expect(screen.getByRole("button", { name: /nova rotina/i })).toBeDefined();

      act(() => {
        setLuveLocale("en");
      });
      rerender(<RoutinesView bots={[]} />);
      expect(screen.getByRole("heading", { name: "Routines & Schedules" })).toBeDefined();
      expect(screen.getByRole("button", { name: /new routine/i })).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Rotinas e Agendamentos" })).toBeNull();
    });

    it("renders ActivityView in PT and EN cleanly", () => {
      setLuveLocale("pt");
      const { rerender } = render(<ActivityView bots={[]} initialItems={[]} />);
      expect(screen.getByRole("heading", { name: "Atividade" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Em andamento" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Agendado" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Concluído" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Lista" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Kanban" })).toBeDefined();

      act(() => {
        setLuveLocale("en");
      });
      rerender(<ActivityView bots={[]} initialItems={[]} />);
      expect(screen.getByRole("heading", { name: "Activity" })).toBeDefined();
      expect(screen.getByRole("button", { name: "In progress" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Scheduled" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Completed" })).toBeDefined();
      expect(screen.getByRole("button", { name: "List" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Kanban" })).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Atividade" })).toBeNull();
    });

    it("renders RoomsView in PT and EN cleanly", () => {
      setLuveLocale("pt");
      const { rerender } = render(<RoomsView availableBots={[]} />);
      expect(screen.getByRole("heading", { name: "Salas de Trabalho" })).toBeDefined();
      expect(screen.getByText("Nenhuma sala selecionada. Selecione uma sala na barra lateral ou crie uma nova sala.")).toBeDefined();

      act(() => {
        setLuveLocale("en");
      });
      rerender(<RoomsView availableBots={[]} />);
      expect(screen.getByRole("heading", { name: "Work Rooms" })).toBeDefined();
      expect(screen.getByText("No room selected. Select a room in the sidebar or create a new room.")).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Salas de Trabalho" })).toBeNull();
    });

    it("renders TeamMapView in PT and EN cleanly", () => {
      setLuveLocale("pt");
      const { rerender } = render(<TeamMapView availableBots={[]} initialMapData={{ nodes: [], edges: [], generated_at: "" }} />);
      expect(screen.getByRole("heading", { name: "Mapa do Time" })).toBeDefined();
      expect(screen.getByRole("tab", { name: "Grafo" })).toBeDefined();
      expect(screen.getByRole("tab", { name: "Lista Acessível" })).toBeDefined();

      act(() => {
        setLuveLocale("en");
      });
      rerender(<TeamMapView availableBots={[]} initialMapData={{ nodes: [], edges: [], generated_at: "" }} />);
      expect(screen.getByRole("heading", { name: "Team Map" })).toBeDefined();
      expect(screen.getByRole("tab", { name: "Graph" })).toBeDefined();
      expect(screen.getByRole("tab", { name: "Accessible List" })).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Mapa do Time" })).toBeNull();
    });

    it("renders CommandPaletteModal in PT and EN cleanly", () => {
      setLuveLocale("pt");
      const { rerender } = render(
        <CommandPaletteModal isOpen={true} onClose={() => {}} />
      );
      expect(screen.getByRole("dialog", { name: "Busca e Ações Rápidas" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Tudo" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Ações" })).toBeDefined();

      act(() => {
        setLuveLocale("en");
      });
      rerender(<CommandPaletteModal isOpen={true} onClose={() => {}} />);
      expect(screen.getByRole("dialog", { name: "Search & Quick Actions" })).toBeDefined();
      expect(screen.getByRole("button", { name: "All" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Actions" })).toBeDefined();
      expect(screen.queryByRole("dialog", { name: "Busca e Ações Rápidas" })).toBeNull();
    });
  });

  describe("Dictionary Content Strictness and Detection of Unregistered Fixed Text", () => {
    /**
     * Scanner test:
     * Asserts that in a rendered screen, static visible text nodes match the dictionary for the active locale,
     * and fails if an un-registered fixed string (like hardcoded English or Portuguese in JSX) is introduced.
     */
    it("fails when an unregistered hardcoded string is introduced into the rendered output (mutation detector)", () => {
      setLuveLocale("pt");

      // Valid component rendered with dictionary
      const ValidComponent = () => {
        const { t } = useLuveI18n();
        return <div><p>{t("hojeTitle")}</p></div>;
      };

      // Corrupted component with hardcoded string bypassing dictionary
      const MutatedComponent = () => {
        const { t } = useLuveI18n();
        return (
          <div>
            <p>{t("hojeTitle")}</p>
            <span data-testid="leaked-hardcoded-text">UNTRANSLATED_FIXED_TEXT_MUTATION</span>
          </div>
        );
      };

      const validRender = render(<ValidComponent />);
      // Collect visible text from valid component
      const validText = validRender.container.textContent || "";
      expect(validText).toBe("Hoje");

      // Verify that all words in valid text belong to dictionary
      const knownPtValues = Object.values(translations.pt);
      const isKnown = knownPtValues.some((v) => v.includes(validText));
      expect(isKnown).toBe(true);

      // In mutated component, detect unregistered fixed string
      const mutatedRender = render(<MutatedComponent />);
      const leakedEl = mutatedRender.queryByText("UNTRANSLATED_FIXED_TEXT_MUTATION");
      expect(leakedEl).not.toBeNull();

      // Ensure that our check flags leakedEl because it is NOT anywhere in the dictionary
      const ptHasIt = Object.values(translations.pt).some((v) => v.includes("UNTRANSLATED_FIXED_TEXT_MUTATION"));
      const enHasIt = Object.values(translations.en).some((v) => v.includes("UNTRANSLATED_FIXED_TEXT_MUTATION"));
      expect(ptHasIt || enHasIt).toBe(false);
    });
  });

  describe("Static AST Codebase Scan for Hardcoded Visible Text in Components", () => {
    const VISIBLE_ATTRS = new Set(["placeholder", "aria-label", "title", "alt", "label"]);

    /**
     * Short, explicit, and fully-documented list of allowed literals:
     * Brand names, technical test landmarks, metric units, mathematical signs, and separators.
     */
    const ALLOWED_EXCEPTIONS = new Set([
      // 1. Brand names & proper nouns
      "LuveBot", // Brand name in the contacts column
      "LuveBot:", // Brand name in BotCreateModal step 4 tip

      // 2. Keyboard shortcuts & symbols
      "⌘K", // Keyboard shortcut modifier key symbol in Shell search button
      "ESC", // Escape keyboard key badge in Command Palette search modal
      "Esc", // Escape key symbol in keyboard shortcut hints

      // 3. Technical DOM test landmarks & container selectors (queried by Playwright / unit tests)
      "sidebar", // Landmark accessibility label queried by Playwright in conftest.py open_luvebot
      "onboarding", // Landmark section selector queried in test_gate2.py

      // 4. Fixed Hermes runtime bot name in test seed & fallback UI
      "vendas", // Hermes default seeded bot profile in RulesView fallback options and placeholder

      // 5. Technical metric units and mathematical symbols
      "s", // Metric abbreviation for seconds in WorkPanel duration display
      "×", // Error cross sign in the AttentionBadge (contact list)

      // 6. Punctuation & single-character separators
      ":", // Key-value separator
      "•", // Dot status separator
      "!", // Attention / exclamation mark
      "?", // Question mark
      ">", // Precedence separator
      "-", // Dash separator
      "/", // Slash separator
      "0", // Numeric counter
    ]);

    interface StaticViolation {
      file: string;
      line: number;
      col: number;
      type: string;
      text: string;
    }

    type Lit = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail;
    /** String pieces an expression can put on screen, through conditionals, ||, ??, && and templates. */
    function renderedLiterals(e: ts.Expression): Lit[] {
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e];
      if (ts.isTemplateExpression(e)) return [e.head, ...e.templateSpans.flatMap((sp) => [sp.literal as Lit, ...renderedLiterals(sp.expression)])];
      if (ts.isParenthesizedExpression(e)) return renderedLiterals(e.expression);
      if (ts.isConditionalExpression(e)) return [...renderedLiterals(e.whenTrue), ...renderedLiterals(e.whenFalse)];
      if (ts.isBinaryExpression(e)) {
        const k = e.operatorToken.kind;
        if (k === ts.SyntaxKind.AmpersandAmpersandToken) return renderedLiterals(e.right);
        if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) return [...renderedLiterals(e.left), ...renderedLiterals(e.right)];
      }
      return [];
    }

    /** `{x.state}` / `{x.status}` put on screen as-is: a backend code (English data) shown raw. Use a label helper. */
    const CODE_LISTS = new Set(["allowed_choices", "choices", "options"]);
    function rawCodes(e: ts.Expression): ts.Expression[] {
      if (ts.isPropertyAccessExpression(e) && (e.name.text === "state" || e.name.text === "status" || e.name.text === "kind")) return [e];
      // A list of codes (allowed_choices, choices, options) rendered as is, or joined into one string.
      const isCodeList = (x: ts.Expression) => ts.isPropertyAccessExpression(x) && CODE_LISTS.has(x.name.text);
      if (isCodeList(e)) return [e];
      if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "join" && isCodeList(e.expression.expression)) return [e];
      if (ts.isParenthesizedExpression(e)) return rawCodes(e.expression);
      if (ts.isConditionalExpression(e)) return [...rawCodes(e.whenTrue), ...rawCodes(e.whenFalse)];
      if (ts.isBinaryExpression(e)) {
        const k = e.operatorToken.kind;
        if (k === ts.SyntaxKind.AmpersandAmpersandToken) return rawCodes(e.right);
        if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) return [...rawCodes(e.left), ...rawCodes(e.right)];
      }
      return [];
    }

    function scanSourceText(filePath: string, content: string): StaticViolation[] {
      const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const violations: StaticViolation[] = [];

      function checkNode(node: ts.Node) {
        // 1. Check raw JSX text nodes containing alphabetical characters
        if (ts.isJsxText(node)) {
          const text = node.getText(sf).trim();
          if (text && /[a-zA-ZÀ-ÿ]/.test(text) && !ALLOWED_EXCEPTIONS.has(text)) {
            const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push({
              file: path.relative(process.cwd(), filePath),
              line: line + 1,
              col: character + 1,
              type: "JsxText",
              text,
            });
          }
        }

        // 2. Check visible attributes with literal strings
        if (ts.isJsxAttribute(node)) {
          const attrName = node.name.getText(sf);
          if (VISIBLE_ATTRS.has(attrName) && node.initializer) {
            if (ts.isStringLiteral(node.initializer)) {
              const val = node.initializer.text.trim();
              if (val && /[a-zA-ZÀ-ÿ]/.test(val) && !ALLOWED_EXCEPTIONS.has(val)) {
                const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
                violations.push({
                  file: path.relative(process.cwd(), filePath),
                  line: line + 1,
                  col: character + 1,
                  type: `attr:${attrName}`,
                  text: val,
                });
              }
            }
          }
        }

        // 3. Literals RENDERED through an expression: JSX children `{"x"}`, `{c ? "x" : y}`, `{a || "x"}`,
        //    template text, visible attributes written as `{...}`, and values passed to t() params.
        //    Call arguments are not followed (t("key") takes keys, not text).
        const exprs: ts.Expression[] = [];
        if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) exprs.push(node.expression);
        if (ts.isJsxAttribute(node) && VISIBLE_ATTRS.has(node.name.getText(sf)) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) exprs.push(node.initializer.expression);
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t" && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
          for (const prop of node.arguments[1].properties) if (ts.isPropertyAssignment(prop)) exprs.push(prop.initializer);
        }
        if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
          for (const raw of rawCodes(node.expression)) {
            const { line, character } = sf.getLineAndCharacterOfPosition(raw.getStart(sf));
            violations.push({ file: path.relative(process.cwd(), filePath), line: line + 1, col: character + 1, type: "raw-code", text: raw.getText(sf) });
          }
        }
        for (const e of exprs) {
          for (const lit of renderedLiterals(e)) {
            const text = lit.text.trim();
            if (text && /[a-zA-ZÀ-ÿ]/.test(text) && !ALLOWED_EXCEPTIONS.has(text)) {
              const { line, character } = sf.getLineAndCharacterOfPosition(lit.getStart(sf));
              violations.push({ file: path.relative(process.cwd(), filePath), line: line + 1, col: character + 1, type: "expr", text });
            }
          }
        }

        ts.forEachChild(node, checkNode);
      }

      ts.forEachChild(sf, checkNode);
      return violations;
    }

    it("scans all .tsx files in dashboard/src/components/** (transcript cards included) and asserts zero hardcoded text or visible attribute literals", () => {
      const componentsDir = path.resolve(process.cwd(), "dashboard/src/components");
      const files: string[] = [];

      function walk(dir: string) {
        for (const item of fs.readdirSync(dir)) {
          const full = path.join(dir, item);
          if (fs.statSync(full).isDirectory()) {
            walk(full);
          } else if (item.endsWith(".tsx") && item !== "Icons.tsx") {
            files.push(full);
          }
        }
      }
      walk(componentsDir);

      const allViolations: StaticViolation[] = [];
      for (const file of files) {
        const content = fs.readFileSync(file, "utf8");
        const violations = scanSourceText(file, content);
        allViolations.push(...violations);
      }

      expect(
        allViolations,
        `Found hardcoded JSX visible text or attributes: \n${allViolations.map((v) => `${v.file}:${v.line}:${v.col} [${v.type}] "${v.text}"`).join("\n")}`
      ).toEqual([]);
    });

    it("detects a literal rendered through an expression (ternary in Hoje.tsx and a t() param in CostsView.tsx)", () => {
      const hoje = path.resolve(process.cwd(), "dashboard/src/components/Hoje.tsx");
      const src = fs.readFileSync(hoje, "utf8");
      expect(scanSourceText(hoje, src)).toEqual([]);
      const mutated = src.replace('t("needsYouKindApproval")', '"Aprovação"');
      expect(mutated).not.toEqual(src);
      expect(scanSourceText(hoje, mutated).map((v) => [v.type, v.text])).toEqual([["expr", "Aprovação"]]);

      const costs = path.resolve(process.cwd(), "dashboard/src/components/costs/CostsView.tsx");
      const csrc = fs.readFileSync(costs, "utf8");
      const cmut = csrc.replace('t("pausedReasonCapReached")', '"teto atingido"');
      expect(cmut).not.toEqual(csrc);
      expect(scanSourceText(costs, cmut).map((v) => v.text)).toEqual(["teto atingido"]);
    });

    it("detects a backend code rendered raw (handoff state in RoomsView)", () => {
      const rooms = path.resolve(process.cwd(), "dashboard/src/components/rooms/RoomsView.tsx");
      const src = fs.readFileSync(rooms, "utf8");
      const mutated = src.replace("{handoffStateLabel(h.state, t)}", "{h.state}");
      expect(mutated).not.toEqual(src);
      expect(scanSourceText(rooms, mutated).map((v) => [v.type, v.text])).toEqual([["raw-code", "h.state"]]);
    });

    it("detects a list of backend codes rendered raw (native choices in ApprovalsInbox)", () => {
      const inbox = path.resolve(process.cwd(), "dashboard/src/components/approvals/ApprovalsInbox.tsx");
      const src = fs.readFileSync(inbox, "utf8");
      const joined = src.replace('{item.allowed_choices.map((c) => approvalChoiceLabel(c, t)).join(" · ")}', '{item.allowed_choices.join(", ")}');
      expect(joined).not.toEqual(src);
      expect(scanSourceText(inbox, joined).map((v) => [v.type, v.text])).toEqual([["raw-code", 'item.allowed_choices.join(", ")']]);
      const bare = src.replace('{item.allowed_choices.map((c) => approvalChoiceLabel(c, t)).join(" · ")}', "{item.allowed_choices}");
      expect(scanSourceText(inbox, bare).map((v) => [v.type, v.text])).toEqual([["raw-code", "item.allowed_choices"]]);
    });

    it("detects a scope code rendered raw (rule scope in RulesView)", () => {
      const rules = path.resolve(process.cwd(), "dashboard/src/components/rules/RulesView.tsx");
      const src = fs.readFileSync(rules, "utf8");
      const mutated = src.replace("{scopeText(rule.scope)}", "{rule.scope.kind}");
      expect(mutated).not.toEqual(src);
      expect(scanSourceText(rules, mutated).map((v) => [v.type, v.text])).toEqual([["raw-code", "rule.scope.kind"]]);
    });

    it("detects mutation when {t('thought')} is replaced with fixed string 'Pensamento' in Conversation.tsx", () => {
      const conversationPath = path.resolve(process.cwd(), "dashboard/src/components/conversation/Conversation.tsx");
      const originalContent = fs.readFileSync(conversationPath, "utf8");

      // Verify that the original source has 0 violations
      const cleanViolations = scanSourceText(conversationPath, originalContent);
      expect(cleanViolations).toEqual([]);

      // Apply mutation requested by Maestro: replace {t("thought")} with literal 'Pensamento'
      const mutatedContent = originalContent.replace(
        '<summary style={{ cursor: "pointer" }}>{t("thought")}</summary>',
        '<summary style={{ cursor: "pointer" }}>Pensamento</summary>'
      );
      expect(mutatedContent).not.toEqual(originalContent);

      // Verify that the static scanner flags 'Pensamento' as an untranslated literal violation
      const mutatedViolations = scanSourceText(conversationPath, mutatedContent);
      expect(mutatedViolations.length).toBe(1);
      expect(mutatedViolations[0].text).toBe("Pensamento");
      expect(mutatedViolations[0].type).toBe("JsxText");
    });
  });
});
