// Handing a generated file to the browser.
//
// The obvious three-liner — make an anchor, click it, revoke the URL — works on
// desktop and quietly does nothing on phones, which is exactly the bug members
// reported on the Payouts page. Two reasons:
//
//   * a detached anchor. Desktop Chrome honours a synthetic click on an element
//     that was never in the document; several mobile browsers don't.
//   * revoking immediately. click() only *schedules* the download; mobile
//     browsers fetch the blob: URL a tick later, by which point a synchronous
//     revokeObjectURL has already destroyed it. Nothing downloads, nothing
//     errors — the button just looks dead.
//
// So: attach, click, detach, and let the URL live long enough to be read.

/** How long the blob: URL stays alive after the click. Generous on purpose. */
const REVOKE_AFTER_MS = 60_000;

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}

export function downloadCsv(rows: string[], filename: string): void {
  // BOM so Excel opens member names with non-ASCII characters correctly
  downloadBlob(new Blob(["﻿" + rows.join("\n")], { type: "text/csv;charset=utf-8" }), filename);
}
