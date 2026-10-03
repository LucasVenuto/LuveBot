// tests/unit/ui/wordmark.test.tsx
// The sidebar wordmark follows LuveBot's root scheme (T11.0): white letters on the dark palette, dark letters on the light one.
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Wordmark } from "@/components/ui/Wordmark";

afterEach(cleanup);

describe("Wordmark", () => {
  it("uses the white wordmark on the dark scheme and the dark one on the light scheme", () => {
    render(<Wordmark scheme="dark" />);
    expect(screen.getByRole("img", { name: "LuveBot" }).getAttribute("src")).toMatch(/luvebot-wordmark-white\.svg$/);
    cleanup();
    render(<Wordmark scheme="light" />);
    expect(screen.getByRole("img", { name: "LuveBot" }).getAttribute("src")).toMatch(/luvebot-wordmark\.svg$/);
  });
});
