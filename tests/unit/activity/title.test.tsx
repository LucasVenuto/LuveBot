// tests/unit/activity/title.test.tsx
// An activity's title is never the backend's English placeholder (T11.0): a conversation run reads "Conversa".
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Hoje } from "@/components/Hoje";
import { activityTitle } from "@/components/labels";
import { translations } from "@/i18n";
import type { ActivityItem } from "@/api/types";

afterEach(cleanup);

const item = (id: string, kind: ActivityItem["kind"], title: string | null, status: ActivityItem["status"] = "done"): ActivityItem => ({
  id, kind, bot: "vendas", title, origin: "message", status, started_at: null, ended_at: null,
});
const t = (key: keyof typeof translations.pt) => translations.pt[key];

describe("activity title", () => {
  it("a run with no title, or with the old English placeholder, reads 'Conversa'; a real title is kept", () => {
    expect(activityTitle(item("run:1", "run", "Conversation run"), t)).toBe("Conversa");
    expect(activityTitle(item("run:2", "run", null), t)).toBe("Conversa");
    expect(activityTitle(item("run:3", "run", "Responder 14 tickets"), t)).toBe("Responder 14 tickets");
  });

  it("routines and tasks without a title (null from the backend, or its old English placeholders) read by their kind", () => {
    expect(activityTitle(item("routine_run:s1", "routine_run", null), t)).toBe("Rotina");
    expect(activityTitle({ ...item("routine_run:s2", "routine_run", "Routine job42"), links: { job_id: "job42" } }, t)).toBe("Rotina");
    expect(activityTitle(item("routine_due:j1", "routine_due", null), t)).toBe("Rotina agendada");
    expect(activityTitle(item("routine_due:j2", "routine_due", "Routine"), t)).toBe("Rotina agendada");
    expect(activityTitle(item("task:t1", "task", null), t)).toBe("Tarefa");
    expect(activityTitle(item("task:t2", "task", "Task"), t)).toBe("Tarefa");
    // real titles are kept, including one that merely starts like the placeholder
    expect(activityTitle(item("routine_due:j3", "routine_due", "Relatório da manhã"), t)).toBe("Relatório da manhã");
    expect(activityTitle({ ...item("routine_run:s3", "routine_run", "Routine semanal"), links: { job_id: "job42" } }, t)).toBe("Routine semanal");
    const en = (key: keyof typeof translations.en) => translations.en[key];
    expect(activityTitle(item("task:t3", "task", null), en)).toBe("Task");
    expect(activityTitle(item("routine_due:j4", "routine_due", null), en)).toBe("Scheduled routine");
  });

  it("Hoje shows 'Conversa' in Concluído hoje and Em andamento, never 'Conversation run'", () => {
    render(<Hoje completedItems={[item("run:a", "run", "Conversation run")]} inProgressItems={[item("run:b", "run", null, "running")]} />);
    expect(screen.getByTestId("completed-today-item-run:a").textContent).toContain("Conversa");
    expect(screen.getByTestId("in-progress-item-run:b").textContent).toContain("Conversa");
    expect(screen.queryByText(/Conversation run/)).toBeNull();
  });
});
