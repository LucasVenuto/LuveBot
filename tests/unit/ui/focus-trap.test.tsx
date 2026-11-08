// tests/unit/ui/focus-trap.test.tsx
// The focus trap moves focus when a dialog OPENS (to its first control) and when it CLOSES (back to what opened it), and at no other time. Callers pass an inline `onClose` (a new function at
// every render): that must not move focus while the dialog is open (a streamed token, a poll, a keystroke in the caller re-renders it) and must not pull it back to the old trigger after it closed.
// Found by a phone test that failed only under load: the work panel's focus on a turn was taken by the first button at the next re-render of the conversation.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useFocusTrap } from "@/hooks/useFocusTrap";

function Harness({ open, onClose, tick }: { open: boolean; onClose: () => void; tick: number }) {
  const ref = useFocusTrap<HTMLDivElement>({ isOpen: open, onClose });
  return (
    <div>
      <button type="button">opener</button>
      <input aria-label="composer" />
      <span data-testid="tick">{tick}</span>
      {open && (
        <div ref={ref} role="dialog" tabIndex={-1}>
          <button type="button">first</button>
          <input aria-label="field in the dialog" />
          <button type="button">last</button>
        </div>
      )}
    </div>
  );
}
afterEach(cleanup);
const focused = () => document.activeElement as HTMLElement;

describe("when focus moves", () => {
  it("on open: to the first control of the dialog; on close: back to what had focus before, once", () => {
    const r = render(<Harness open={false} onClose={() => {}} tick={0} />);
    screen.getByText("opener").focus();
    r.rerender(<Harness open onClose={() => {}} tick={0} />);
    expect(focused().textContent).toBe("first");
    r.rerender(<Harness open={false} onClose={() => {}} tick={0} />);
    expect(focused().textContent).toBe("opener");
  });

  it("while it is OPEN, a re-render of the caller with a NEW onClose does not move focus (the person is in a field, or something else was focused on purpose)", () => {
    const r = render(<Harness open onClose={() => {}} tick={0} />);
    const field = screen.getByLabelText("field in the dialog");
    field.focus();
    for (let i = 1; i <= 5; i++) r.rerender(<Harness open onClose={() => {}} tick={i} />);   // five renders, five new arrow functions
    expect(focused()).toBe(field);
    expect(screen.getByTestId("tick").textContent).toBe("5");
  });

  it("after it is CLOSED, later re-renders do not pull focus back to the old trigger", () => {
    const r = render(<Harness open={false} onClose={() => {}} tick={0} />);
    screen.getByText("opener").focus();
    r.rerender(<Harness open onClose={() => {}} tick={0} />);
    r.rerender(<Harness open={false} onClose={() => {}} tick={0} />);
    expect(focused().textContent).toBe("opener");                                               // restored once
    const composer = screen.getByLabelText("composer");
    composer.focus();
    for (let i = 1; i <= 5; i++) r.rerender(<Harness open={false} onClose={() => {}} tick={i} />);
    expect(focused()).toBe(composer);                                                            // the person is typing in the composer: it keeps focus
  });

  it("never opened: nothing is focused by it, whatever re-renders", () => {
    const r = render(<Harness open={false} onClose={() => {}} tick={0} />);
    const composer = screen.getByLabelText("composer");
    composer.focus();
    for (let i = 1; i <= 3; i++) r.rerender(<Harness open={false} onClose={() => {}} tick={i} />);
    expect(focused()).toBe(composer);
  });

  it("opens again: the first control again, and back to the NEW trigger on the second close", () => {
    const r = render(<Harness open={false} onClose={() => {}} tick={0} />);
    screen.getByText("opener").focus();
    r.rerender(<Harness open onClose={() => {}} tick={0} />);
    r.rerender(<Harness open={false} onClose={() => {}} tick={0} />);
    screen.getByLabelText("composer").focus();
    r.rerender(<Harness open onClose={() => {}} tick={0} />);
    expect(focused().textContent).toBe("first");
    r.rerender(<Harness open={false} onClose={() => {}} tick={0} />);
    expect(focused().getAttribute("aria-label")).toBe("composer");
  });
});

describe("Escape and Tab", () => {
  it("Escape calls the LATEST onClose, not the one of the render that opened the dialog", () => {
    const first = vi.fn(), latest = vi.fn();
    const r = render(<Harness open onClose={first} tick={0} />);
    r.rerender(<Harness open onClose={latest} tick={1} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("Tab wraps from the last control to the first, Shift+Tab from the first to the last", () => {
    render(<Harness open onClose={() => {}} tick={0} />);
    screen.getByText("last").focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(focused().textContent).toBe("first");
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(focused().textContent).toBe("last");
  });

  it("a keystroke in a field of the dialog that re-renders the caller keeps focus in the field (the caller holds the text)", () => {
    function Typing() {
      const [text, setText] = React.useState("");
      const ref = useFocusTrap<HTMLDivElement>({ isOpen: true, onClose: () => setText("") });   // a new onClose at every keystroke
      return <div ref={ref} role="dialog"><button type="button">first</button><input aria-label="typed" value={text} onChange={(e) => setText(e.target.value)} /></div>;
    }
    render(<Typing />);
    const input = screen.getByLabelText("typed") as HTMLInputElement;
    input.focus();
    for (const ch of ["a", "b", "c"]) { fireEvent.change(input, { target: { value: input.value + ch } }); }
    expect(input.value).toBe("abc");
    expect(focused()).toBe(input);
  });
});
