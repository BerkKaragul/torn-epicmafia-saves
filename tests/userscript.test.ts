import { describe, expect, it } from "vitest";
import { USERSCRIPT_TEMPLATE } from "@/lib/userscript";

describe("userscript template", () => {
  it("carries every placeholder the widget route fills in", () => {
    for (const p of ["__SITE__", "__HOST__", "__TOKEN__", "__INSTALL_URL__"]) {
      expect(USERSCRIPT_TEMPLATE).toContain(p);
    }
  });
  it("is a valid userscript with update URLs once filled in", () => {
    const filled = USERSCRIPT_TEMPLATE.replaceAll("__SITE__", "https://cw.example")
      .replaceAll("__HOST__", "cw.example")
      .replaceAll("__TOKEN__", "a".repeat(32))
      .replaceAll("__INSTALL_URL__", "https://cw.example/widget/x/chainwatch.user.js");
    expect(filled).toMatch(/^\/\/ ==UserScript==/);
    expect(filled).toContain("// @connect      cw.example");
    expect(filled).toContain("// @updateURL    https://cw.example/widget/x/chainwatch.user.js");
    expect(filled).toContain('"/api/widget?token=" + TOKEN');
    expect(filled).not.toMatch(/__[A-Z_]+__/);
    // the body must still parse as JavaScript
    const body = filled.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, "");
    expect(() => new Function(body)).not.toThrow();
  });
});
