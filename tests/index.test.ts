import { describe, test, expect } from "bun:test";
describe("bulk-email-processor", () => {
  test("module loads", async () => { const m = await import("./index"); expect(m).toBeDefined(); });
});
