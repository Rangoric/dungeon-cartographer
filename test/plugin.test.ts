import { describe, it, expect } from "vitest";

// Smoke test: importing the plugin entry pulls in the `obsidian` mock and
// Three.js, and the class hierarchy (Plugin / ItemView subclasses) must
// resolve at module-eval time. If the mock drifts out of sync with what the
// plugin extends, this import throws and the test fails.
describe("plugin entry point", () => {
  it("imports cleanly and exports a default Plugin class", async () => {
    const mod = await import("../src/main");
    expect(typeof mod.default).toBe("function");
  });
});
