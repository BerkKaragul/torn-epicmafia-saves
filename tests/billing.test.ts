import { describe, expect, it } from "vitest";
import {
  creditedSeconds,
  findReceiveLogTypes,
  itemQuantity,
  parseFactionTag,
  parseItemReceive,
  subscriptionActive,
} from "@/supabase/functions/_shared/logic/billing";

const XAN = 206;

describe("findReceiveLogTypes", () => {
  it("picks item-receive titles and nothing else", () => {
    expect(
      findReceiveLogTypes([
        { id: 4102, title: "Item send" },
        { id: 4103, title: "Item receive" },
        { id: 4104, title: "Items received from faction" },
        { id: 1000, title: "Attack receive" },
        { id: 2000, title: "Money receive" },
      ]),
    ).toEqual([4103, 4104]);
  });
});

describe("itemQuantity", () => {
  it("reads an items array", () => {
    expect(
      itemQuantity({ items: [{ id: XAN, uid: 1, qty: 5 }, { id: 180, qty: 9 }] }, XAN),
    ).toBe(5);
  });
  it("sums repeated entries and alternate key names", () => {
    expect(
      itemQuantity({ items: [{ item: "206", quantity: 2 }, { item_id: 206, amount: 3 }] }, XAN),
    ).toBe(5);
  });
  it("reads a map of id → qty", () => {
    expect(itemQuantity({ items: { "206": 4, "180": 1 } }, XAN)).toBe(4);
    expect(itemQuantity({ items: { "206": { qty: 7 } } }, XAN)).toBe(7);
  });
  it("reads a flat single item", () => {
    expect(itemQuantity({ item: 206, quantity: 3 }, XAN)).toBe(3);
    expect(itemQuantity({ items: { id: 206, qty: 2 } }, XAN)).toBe(2);
  });
  it("counts one when the quantity is missing", () => {
    expect(itemQuantity({ items: [{ id: 206 }] }, XAN)).toBe(1);
  });
  it("ignores other items", () => {
    expect(itemQuantity({ items: [{ id: 180, qty: 10 }] }, XAN)).toBe(0);
    expect(itemQuantity({}, XAN)).toBe(0);
  });
});

describe("parseFactionTag", () => {
  it("finds CW / faction tags", () => {
    expect(parseFactionTag("CW 12345")).toBe(12345);
    expect(parseFactionTag("for cw#12345 thanks")).toBe(12345);
    expect(parseFactionTag("Faction: 777")).toBe(777);
  });
  it("returns null otherwise", () => {
    expect(parseFactionTag("here you go")).toBeNull();
    expect(parseFactionTag(null)).toBeNull();
    expect(parseFactionTag("cwx 123")).toBeNull();
  });
});

describe("parseItemReceive", () => {
  it("extracts sender, quantity, message and target faction", () => {
    const r = parseItemReceive(
      {
        id: "abc",
        timestamp: 1_700_000_000,
        details: { id: 4103, title: "Item receive", category: "Items" },
        data: { sender: 123, items: [{ id: 206, qty: 10 }], message: "CW 999" },
        params: {},
      },
      XAN,
    );
    expect(r).toEqual({
      logId: "abc",
      receivedAt: 1_700_000_000,
      senderId: 123,
      quantity: 10,
      message: "CW 999",
      targetFactionId: 999,
    });
  });
  it("returns null when no Xanax arrived", () => {
    expect(
      parseItemReceive({ id: 1, timestamp: 1, data: { sender: 1, items: [{ id: 1, qty: 1 }] } }, XAN),
    ).toBeNull();
  });
  it("tolerates a missing sender", () => {
    const r = parseItemReceive({ id: 2, timestamp: 1, data: { items: [{ id: 206, qty: 1 }] } }, XAN);
    expect(r?.senderId).toBeNull();
    expect(r?.logId).toBe("2");
  });
});

describe("creditedSeconds", () => {
  it("is proportional to the price", () => {
    expect(creditedSeconds(10, 10, 15)).toBe(15 * 86400);
    expect(creditedSeconds(5, 10, 15)).toBe(7.5 * 86400);
    expect(creditedSeconds(1, 3, 1)).toBe(28800);
  });
  it("is zero for nonsense input", () => {
    expect(creditedSeconds(0, 10, 15)).toBe(0);
    expect(creditedSeconds(5, 0, 15)).toBe(0);
  });
});

describe("subscriptionActive", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  it("needs a future expiry and no suspension", () => {
    expect(subscriptionActive({ subscription_expires_at: "2026-01-02T00:00:00Z", suspended: false }, now)).toBe(true);
    expect(subscriptionActive({ subscription_expires_at: "2025-12-31T00:00:00Z", suspended: false }, now)).toBe(false);
    expect(subscriptionActive({ subscription_expires_at: null, suspended: false }, now)).toBe(false);
    expect(subscriptionActive({ subscription_expires_at: "2026-01-02T00:00:00Z", suspended: true }, now)).toBe(false);
  });
});
