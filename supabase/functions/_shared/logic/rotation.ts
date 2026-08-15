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
  /**
   * False while the member physically can't attack (flying, hospital, jail).
   * They keep their shift and their place in line — they're just skipped for
   * the turn until they're back. Undefined means available.
   */
  available?: boolean;
  /**
   * Unix seconds; set when the member taps "skip my turn". Folded into the sort
   * key so skipping sends them to the back exactly like performing a save would,
   * but without the pay/stat credit. Null/undefined means never skipped.
   */
  deprioritizedAt?: number | null;
}

export function rotationOrder(shifts: ShiftLite[]): number[] {
  return shifts
    .filter((s) => s.available !== false)
    .map((s) => ({
      id: s.memberId,
      key: Math.max(s.startedAt, s.lastSaveAt ?? s.startedAt, s.deprioritizedAt ?? 0),
    }))
    .sort((a, b) => a.key - b.key || a.id - b.id)
    .map((s) => s.id);
}

export function turnMemberId(shifts: ShiftLite[]): number | null {
  return rotationOrder(shifts)[0] ?? null;
}
