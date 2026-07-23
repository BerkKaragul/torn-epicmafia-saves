import { describe, expect, test } from "vitest";
import { perSaverHourlyRate, saveBonus } from "../supabase/functions/_shared/logic/pay.ts";

describe("perSaverHourlyRate", () => {
  const R = 3_000_000;

  test("a lone saver earns the full posted rate", () => {
    expect(perSaverHourlyRate(R, 1)).toBe(3_000_000);
  });

  test("two savers each earn the full rate (no split at two)", () => {
    expect(perSaverHourlyRate(R, 2)).toBe(3_000_000);
  });

  test("three or more split a pool of double the posted rate", () => {
    expect(perSaverHourlyRate(R, 3)).toBe(2_000_000);
    expect(perSaverHourlyRate(R, 5)).toBe(1_200_000);
    expect(perSaverHourlyRate(R, 6)).toBe(1_000_000);
  });

  test("the pool never exceeds double the posted rate once split", () => {
    for (const n of [3, 4, 8, 20]) {
      expect(perSaverHourlyRate(R, n) * n).toBe(2 * R);
    }
  });

  test("nobody on duty costs nothing", () => {
    expect(perSaverHourlyRate(R, 0)).toBe(0);
  });
});

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
