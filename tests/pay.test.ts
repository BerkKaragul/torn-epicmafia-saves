import { describe, expect, test } from "vitest";
import { saveBonus } from "../supabase/functions/_shared/logic/pay.ts";

describe("saveBonus", () => {
  test("flat mode pays the base regardless of chain size", () => {
    expect(saveBonus("flat", 1_000_000, 47)).toBe(1_000_000);
    expect(saveBonus("flat", 1_000_000, 1200)).toBe(1_000_000);
  });

  test("scaled mode pays base × chain/100", () => {
    expect(saveBonus("scaled", 1_000_000, 500)).toBe(5_000_000);
    expect(saveBonus("scaled", 1_000_000, 1200)).toBe(12_000_000);
  });

  test("scaled mode never pays below the base (floor at 1x for small chains)", () => {
    expect(saveBonus("scaled", 1_000_000, 47)).toBe(1_000_000);
    expect(saveBonus("scaled", 1_000_000, 100)).toBe(1_000_000);
  });

  test("scaled mode rounds to whole dollars", () => {
    expect(saveBonus("scaled", 250_000, 333)).toBe(832_500);
  });

  test("unknown mode falls back to flat", () => {
    expect(saveBonus("weird" as never, 1_000_000, 900)).toBe(1_000_000);
  });
});
