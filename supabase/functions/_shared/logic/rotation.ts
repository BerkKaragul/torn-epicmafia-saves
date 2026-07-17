// Rotation queue for on-duty savers. Stateless and derived: no stored turn
// pointer exists anywhere — the order is recomputed from shifts on demand,
// identically on the poller, the API, and the client.
//
// Sort key: greatest(shift start, last save) ascending, ties by member id.
// Newcomers therefore join at the back, performing a save sends you to the
// back, and leaving duty simply removes you.

export interface ShiftLite {
  memberId: number;
  /** unix seconds */
  startedAt: number;
  /** unix seconds, null until the member performs a save this shift */
  lastSaveAt: number | null;
}

export function rotationOrder(shifts: ShiftLite[]): number[] {
  return shifts
    .map((s) => ({
      id: s.memberId,
      key: Math.max(s.startedAt, s.lastSaveAt ?? s.startedAt),
    }))
    .sort((a, b) => a.key - b.key || a.id - b.id)
    .map((s) => s.id);
}

export function turnMemberId(shifts: ShiftLite[]): number | null {
  return rotationOrder(shifts)[0] ?? null;
}
