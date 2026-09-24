// Subscription billing maths and Torn log parsing. Pure, so it runs in the
// Deno poller and in Next.js (the platform page's "test the vendor key"
// preview) and is unit-tested on its own.
//
// Payment model: a faction pays by sending Xanax in-game to the vendor
// account. The vendor's own item-receive log (Full Access key) is the source of
// truth. The log's `data` object is documented only as "dynamic key-value
// pairs", so the parser below accepts the shapes we could reasonably expect
// rather than one guessed layout — and the platform page shows raw entries so
// the operator can confirm what their key actually returns.

export interface LogEntryLike {
  id: string | number;
  timestamp: number;
  details?: { id?: number; title?: string; category?: string };
  data?: Record<string, unknown> | null;
  params?: Record<string, unknown> | null;
}

export interface ParsedReceipt {
  logId: string;
  receivedAt: number;
  senderId: number | null;
  /** how many of the wanted item arrived in this log entry */
  quantity: number;
  message: string | null;
  /** faction named in the message ("CW 12345"), when the payer names one */
  targetFactionId: number | null;
}

const toInt = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
};

/** Log types whose title reads like "Item receive" / "Item received". */
export function findReceiveLogTypes(types: { id: number; title: string }[]): number[] {
  return types
    .filter((t) => /\bitems?\b/i.test(t.title) && /\breceiv/i.test(t.title))
    .map((t) => t.id);
}

/** Sum of `itemId` in a log's items, whatever shape the items take. */
export function itemQuantity(data: Record<string, unknown>, itemId: number): number {
  const items = data.items ?? data.item;
  let total = 0;

  const fromObj = (o: Record<string, unknown>) => {
    const id = toInt(o.id ?? o.item ?? o.item_id ?? o.ID);
    if (id !== itemId) return;
    total += toInt(o.qty ?? o.quantity ?? o.amount ?? o.count) ?? 1;
  };

  if (Array.isArray(items)) {
    for (const it of items) if (it && typeof it === "object") fromObj(it as Record<string, unknown>);
  } else if (items && typeof items === "object") {
    const o = items as Record<string, unknown>;
    if ("id" in o || "item" in o || "item_id" in o) {
      fromObj(o);
    } else {
      // map form: { "206": 5 } or { "206": { qty: 5 } }
      for (const [k, v] of Object.entries(o)) {
        if (toInt(k) !== itemId) continue;
        if (v && typeof v === "object") {
          const q = v as Record<string, unknown>;
          total += toInt(q.qty ?? q.quantity ?? q.amount) ?? 1;
        } else {
          total += toInt(v) ?? 1;
        }
      }
    }
  } else if (toInt(items) === itemId) {
    // flat form: { item: 206, quantity: 5 }
    total += toInt(data.quantity ?? data.qty ?? data.amount) ?? 1;
  }
  return total;
}

/**
 * "CW 12345", "cw#12345", "faction 12345", "faction:12345" → 12345. Lets one
 * member pay on behalf of a faction they are not (yet) in, or a leader pay
 * from an alt. Anything else → null (credit the sender's own faction).
 */
export function parseFactionTag(message: string | null | undefined): number | null {
  if (!message) return null;
  const m = /\b(?:cw|faction)\s*[:#-]?\s*(\d{1,9})\b/i.exec(message);
  return m ? Number(m[1]) : null;
}

export function parseItemReceive(entry: LogEntryLike, itemId: number): ParsedReceipt | null {
  const data = (entry.data ?? {}) as Record<string, unknown>;
  const quantity = itemQuantity(data, itemId);
  if (quantity <= 0) return null;
  const senderId = toInt(data.sender ?? data.sender_id ?? data.from ?? data.user ?? data.user_id);
  const message = typeof data.message === "string" ? data.message : null;
  return {
    logId: String(entry.id),
    receivedAt: entry.timestamp,
    senderId: senderId && senderId > 0 ? senderId : null,
    quantity,
    message,
    targetFactionId: parseFactionTag(message),
  };
}

/** Subscription seconds bought by `quantity` items at `pricePerPeriod` per `periodDays`. */
export function creditedSeconds(quantity: number, pricePerPeriod: number, periodDays: number): number {
  if (!(quantity > 0) || !(pricePerPeriod > 0) || !(periodDays > 0)) return 0;
  return Math.floor((quantity / pricePerPeriod) * periodDays * 86400);
}

/** Whether a faction may use the app right now. */
export function subscriptionActive(
  f: { subscription_expires_at: string | null; suspended: boolean },
  nowMs = Date.now(),
): boolean {
  return (
    !f.suspended &&
    !!f.subscription_expires_at &&
    Date.parse(f.subscription_expires_at) > nowMs
  );
}
