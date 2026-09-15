import { describe, expect, test } from "vitest";
import { pdfSafe, payoutPdfName, unitRateLine } from "../lib/payoutPdf.ts";
import type { PayoutTotals } from "../lib/payoutPdf.ts";

const totals = (over: Partial<PayoutTotals> = {}): PayoutTotals => ({
  prize: 0,
  sumChain: 0,
  sumRetal: 0,
  distributed: 0,
  grand: 0,
  members: 0,
  ...over,
});

describe("pdfSafe", () => {
  // jsPDF's built-in fonts encode cp1252. An unencodable character doesn't
  // throw — it silently wrecks the spacing of the whole string it appears in,
  // which shipped twice before this guard existed (once for "→", once for "≈").
  test("swaps the symbols that broke the layout for cp1252 equivalents", () => {
    expect(pdfSafe("≈ $1/score")).toBe("~ $1/score");
    expect(pdfSafe("a → b")).toBe("a -> b");
    expect(pdfSafe("2 × hit")).toBe("2 x hit");
    expect(pdfSafe("done ✔")).toBe("done y");
  });

  test("leaves everything cp1252 can render alone", () => {
    // em/en dashes, middle dot and curly quotes all survived in the real PDF
    expect(pdfSafe("War payout — vs Foo · 1 – 2 “x”")).toBe("War payout — vs Foo · 1 – 2 “x”");
    expect(pdfSafe("Åsa's café £5 ½")).toBe("Åsa's café £5 ½");
  });

  test("a name outside cp1252 degrades instead of corrupting its row", () => {
    expect(pdfSafe("日本語")).toBe("???");
    expect(pdfSafe("Berk 日 Karagul")).toBe("Berk ? Karagul");
  });
});

describe("unitRateLine", () => {
  test("reads out both rates", () => {
    expect(unitRateLine(totals({ respectPerUnit: 69134, hitPerUnit: 230028 }))).toBe(
      "$69,134/score · $230,028/hit",
    );
  });

  test("carries no glyph the PDF font can't print", () => {
    const line = unitRateLine(totals({ respectPerUnit: 1, hitPerUnit: 2 }));
    expect(pdfSafe(line)).toBe(line);
  });

  test("payouts frozen before the rates were recorded stay silent", () => {
    // the alternative is printing "$NaN/score" on someone's payslip
    expect(unitRateLine(totals())).toBe("");
    expect(unitRateLine(totals({ respectPerUnit: 500 }))).toBe("$500/score");
  });

  test("a pool that divided nothing is not reported as a rate", () => {
    expect(unitRateLine(totals({ respectPerUnit: 0, hitPerUnit: 0 }))).toBe("");
  });
});

describe("payoutPdfName", () => {
  test("turns an opponent into a safe filename", () => {
    expect(payoutPdfName("Monarch Contagion")).toBe("war-payout-Monarch-Contagion.pdf");
    expect(payoutPdfName("[40959] Epic!")).toBe("war-payout-40959-Epic.pdf");
    expect(payoutPdfName("???")).toBe("war-payout-war.pdf");
  });
});
