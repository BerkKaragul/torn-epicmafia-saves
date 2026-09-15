// Client-side PDF export for a frozen war payout. jsPDF and autotable are
// pulled in with a dynamic import so ~400KB of PDF machinery never lands in the
// bundle of anyone who doesn't press the button.

import { fmtMoney } from "@/lib/format";
import type { WarPayoutConfig, WarPayoutRow } from "@/lib/warPayout";

export interface PayoutTotals {
  prize: number;
  sumChain: number;
  sumRetal: number;
  distributed: number;
  grand: number;
  members: number;
}

export interface PayoutPdfInput {
  opponent: string;
  startedAt: string | null;
  endedAt: string | null;
  ourScore?: number | null;
  theirScore?: number | null;
  savedAt: string | null;
  savedByName?: string | null;
  totals: PayoutTotals;
  lines: WarPayoutRow[];
  config: WarPayoutConfig;
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—";

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "war";

/** Filename the download lands under — also the document's identity in tests. */
export const payoutPdfName = (opponent: string) => `war-payout-${slug(opponent)}.pdf`;

/**
 * Lays out the document but doesn't hand it to the browser, so the layout can
 * be exercised without a download dialog.
 */
export async function buildPayoutPdf(input: PayoutPdfInput) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const { totals, lines, config } = input;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(`War payout — vs ${input.opponent}`, 40, 46);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(110);
  const score =
    input.ourScore != null && input.theirScore != null
      ? `  ·  score ${input.ourScore}–${input.theirScore}`
      : "";
  doc.text(`${fmtDate(input.startedAt)} – ${fmtDate(input.endedAt)}${score}`, 40, 62);
  doc.text(
    `Final data locked ${fmtDate(input.savedAt)}${input.savedByName ? ` by ${input.savedByName}` : ""}` +
      `  ·  ${totals.members} member(s)`,
    40,
    75,
  );

  // headline total, right-aligned against the summary line
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(16, 122, 76);
  doc.text(fmtMoney(totals.grand), pageW - 40, 50, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(110);
  doc.text(
    `chain ${fmtMoney(totals.sumChain)} + retals ${fmtMoney(totals.sumRetal)} + split ${fmtMoney(totals.distributed)}`,
    pageW - 40,
    64,
    { align: "right" },
  );
  doc.text(`pool ${fmtMoney(totals.prize)}`, pageW - 40, 76, { align: "right" });

  const showOutside = config.includeOutside;
  const head = [
    [
      "#",
      "Member",
      "Respect",
      "Hits",
      ...(showOutside ? ["Outside"] : []),
      "Retals",
      "Saves",
      "Assists",
      "Chain $",
      "Retal $",
      "Split $",
      "Total",
    ],
  ];
  const body = lines.map((r, i) => [
    String(i + 1),
    r.name,
    Math.round(r.respect).toLocaleString("en-US"),
    String(r.war_hits),
    ...(showOutside ? [String(r.outside_hits || 0)] : []),
    String(r.retaliations || 0),
    String(r.saves || 0),
    String(r.assists || 0),
    fmtMoney(r.chainPay),
    fmtMoney(r.retalPay),
    fmtMoney(r.share),
    fmtMoney(r.total),
  ]);

  autoTable(doc, {
    head,
    body,
    startY: 92,
    margin: { left: 40, right: 40 },
    styles: { fontSize: 8, cellPadding: 4, lineColor: [225, 225, 225], lineWidth: 0.5 },
    headStyles: { fillColor: [38, 38, 38], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [248, 248, 248] },
    columnStyles: {
      0: { cellWidth: 22, textColor: 150 },
      1: { fontStyle: "bold" },
    },
    // every column after the name is a number — right-align the lot
    didParseCell: (data) => {
      if (data.column.index >= 2) data.cell.styles.halign = "right";
      if (data.column.index === head[0].length - 1) data.cell.styles.fontStyle = "bold";
    },
    foot: [
      [
        "",
        "TOTAL",
        ...Array(head[0].length - 6).fill(""),
        fmtMoney(totals.sumChain),
        fmtMoney(totals.sumRetal),
        fmtMoney(totals.distributed),
        fmtMoney(totals.grand),
      ],
    ],
    footStyles: { fillColor: [235, 235, 235], textColor: 20, fontStyle: "bold", halign: "right" },
    // one grand total at the very end, not a misleading one on every page
    showFoot: "lastPage",
  });

  // the weights are part of the record: without them the numbers can't be
  // re-derived or argued with
  const afterTable =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 92;
  doc.setFontSize(7.5);
  doc.setTextColor(130);
  doc.text(
    `Weights — retal ${fmtMoney(config.retalFixed)} each · respect pool ${config.respectPct}% / hit pool ${100 - config.respectPct}% · ` +
      `save ${config.saveAsHits}x hit + ${config.saveScore}x score · assist ${config.assistAsHits}x hit + ${config.assistScore}x score` +
      (showOutside ? ` · outside ${config.outsideAsHits}x hit` : " · outside hits unpaid"),
    40,
    Math.min(afterTable + 18, doc.internal.pageSize.getHeight() - 24),
    { maxWidth: pageW - 80 },
  );

  return doc;
}

export async function downloadPayoutPdf(input: PayoutPdfInput) {
  const doc = await buildPayoutPdf(input);
  doc.save(payoutPdfName(input.opponent));
}
