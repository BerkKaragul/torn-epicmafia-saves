import { describe, expect, test } from "vitest";
import {
  rotationOrder,
  turnMemberId,
  type ShiftLite,
} from "../supabase/functions/_shared/logic/rotation.ts";

const shift = (memberId: number, startedAt: number, lastSaveAt: number | null = null): ShiftLite => ({
  memberId,
  startedAt,
  lastSaveAt,
});

describe("rotationOrder", () => {
  test("orders by shift start when nobody has saved yet", () => {
    const order = rotationOrder([shift(1, 100), shift(2, 50), shift(3, 75)]);
    expect(order).toEqual([2, 3, 1]);
  });

  test("sends a member to the back after they perform a save", () => {
    const order = rotationOrder([shift(1, 100), shift(2, 50, 200), shift(3, 75)]);
    expect(order).toEqual([3, 1, 2]);
  });

  test("breaks exact ties by lower member id", () => {
    const order = rotationOrder([shift(9, 100), shift(4, 100)]);
    expect(order).toEqual([4, 9]);
  });

  test("a member who leaves and rejoins goes to the back", () => {
    // member 1 rejoined at 300; member 2 saved at 100 but that is still earlier
    const order = rotationOrder([shift(1, 300), shift(2, 50, 100)]);
    expect(order).toEqual([2, 1]);
  });

  test("returns an empty order for no active shifts", () => {
    expect(rotationOrder([])).toEqual([]);
  });
});

describe("rotationOrder: availability", () => {
  test("excludes savers who can't attack right now (flying, hospital, jail)", () => {
    const order = rotationOrder([
      { ...shift(1, 50), available: false },
      shift(2, 100),
      shift(3, 150),
    ]);
    expect(order).toEqual([2, 3]);
  });

  test("passes the turn to the next available saver when the head flies", () => {
    expect(
      turnMemberId([{ ...shift(1, 50), available: false }, shift(2, 100)]),
    ).toBe(2);
  });

  test("treats a missing available flag as available", () => {
    expect(rotationOrder([shift(1, 50), { ...shift(2, 100), available: true }])).toEqual([1, 2]);
  });

  test("returns nobody when every saver is unavailable", () => {
    expect(
      rotationOrder([
        { ...shift(1, 50), available: false },
        { ...shift(2, 100), available: false },
      ]),
    ).toEqual([]);
  });

  test("restores an unavailable saver to their original slot once they're back", () => {
    // member 1 started first, so returning from a flight puts them back at the
    // front — availability gates the queue, it does not reorder it
    expect(rotationOrder([shift(1, 50), shift(2, 100)])).toEqual([1, 2]);
  });
});

describe("turnMemberId", () => {
  test("is the head of the rotation", () => {
    expect(turnMemberId([shift(1, 100), shift(2, 50)])).toBe(2);
  });

  test("is null when nobody is on duty", () => {
    expect(turnMemberId([])).toBeNull();
  });
});
