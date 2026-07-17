// Save bonus valuation. Runs in both the Deno poller (auto-confirmation) and
// Next.js (manual admin attribution) so the two can never disagree.
//
// "scaled" reflects that saving a 1,200-chain matters far more than saving a
// 60-chain: bonus = base × (chain/100), floored at 1× so small-chain saves
// still pay the base. The mode is snapshotted per save at confirmation time,
// so admins can toggle it at any moment without rewriting earned bonuses.

export type SaveBonusMode = "flat" | "scaled";

export function saveBonus(mode: SaveBonusMode, base: number, chainCount: number): number {
  if (mode === "scaled") {
    return Math.round(base * Math.max(1, chainCount / 100));
  }
  return Math.round(base);
}
