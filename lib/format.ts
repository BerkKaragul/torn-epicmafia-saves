// Shared display formatting — one source so money and clocks never render
// differently between the live page, duty page, and payout tables.

export const fmtMoney = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

/** m:ss for timers */
export const fmtClock = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

/** human duration: 1h 23m 45s */
export function fmtDuration(totalS: number): string {
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = Math.floor(totalS % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
