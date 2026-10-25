import { db } from "@/lib/db";
import type { EventPayoutLine, EventPayoutTotals } from "@/lib/types";

// Event payout maths: availability pay accrued on the event's own shifts, plus
// every save confirmed inside the event window at the event's flat per-save
// amount. No pool, no split — what you earned is what you're paid.

interface EventReportRow {
  member_id: number;
  name: string;
  save_seconds: number;
  chain_pay: number;
  saves: number;
  saves_pay: number;
  missed_turns: number;
}

export async function buildEventReport(
  eventId: number,
  saveBonus: number,
): Promise<{ lines: EventPayoutLine[]; totals: EventPayoutTotals } | { error: string }> {
  const { data, error } = await db().rpc("event_report", { p_event: eventId });
  if (error) {
    console.error("event_report failed", error);
    return { error: "Could not build the event report" };
  }
  const lines: EventPayoutLine[] = ((data ?? []) as EventReportRow[])
    .map((r) => {
      const chainPay = Math.round(Number(r.chain_pay) || 0);
      const savesPay = Math.round(Number(r.saves_pay) || 0);
      return {
        member_id: Number(r.member_id),
        name: r.name,
        save_seconds: Number(r.save_seconds) || 0,
        chain_pay: chainPay,
        saves: Number(r.saves) || 0,
        saves_pay: savesPay,
        missed_turns: Number(r.missed_turns) || 0,
        total: chainPay + savesPay,
      };
    })
    .filter((l) => l.total > 0 || l.saves > 0 || l.save_seconds > 0)
    .sort((a, b) => b.total - a.total || b.saves - a.saves || a.name.localeCompare(b.name));

  const chain = lines.reduce((s, l) => s + l.chain_pay, 0);
  const savesPay = lines.reduce((s, l) => s + l.saves_pay, 0);
  return {
    lines,
    totals: {
      chain,
      saves: lines.reduce((s, l) => s + l.saves, 0),
      saves_pay: savesPay,
      grand: chain + savesPay,
      members: lines.length,
      save_bonus: Math.round(saveBonus),
    },
  };
}
