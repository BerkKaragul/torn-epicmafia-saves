// Pure parsers for Torn member status text. No I/O — shared by the Deno poller
// and the Next.js API so the two never disagree on where someone is.
//
// Torn API v2 phrases travel as "Traveling from X to Y" (arrival time `until` is
// often null), and abroad as "In X". Older/other shapes are kept as fallbacks.

/**
 * The country a member is currently in, for display. Null while home (Okay),
 * blocked (hospital/jail), or mid-flight (they're in a plane, not a country).
 */
export function parseCountry(
  state: string,
  description?: string | null,
  details?: string | null,
): string | null {
  for (const raw of [description, details]) {
    if (!raw) continue;
    const d = raw.trim();
    if (state === "Abroad") {
      const m = d.match(/^In (.+)$/i);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Where a flying member is HEADED (direction-aware). The destination is the
 * "to Y" part:
 *   "Traveling from Torn to Switzerland" -> "Switzerland"  (outbound)
 *   "Traveling from Mexico to Torn"      -> "Torn"         (heading home)
 * Only meaningful while state === "Traveling"; returns null otherwise / when
 * the destination can't be read.
 */
export function parseTravelDest(
  description?: string | null,
  details?: string | null,
): string | null {
  for (const raw of [description, details]) {
    if (!raw) continue;
    const d = raw.trim();
    const fromTo = d.match(/^Traveling from .+? to (.+)$/i);
    if (fromTo) return fromTo[1];
    const to = d.match(/^Traveling to (.+)$/i);
    if (to) return to[1];
    if (/^Returning to Torn\b/i.test(d)) return "Torn";
  }
  return null;
}

/**
 * Can this member enlist as a saver right now? Only while they can actually go
 * on to save: already abroad, or flying OUT to another country. Not from Torn,
 * and not on the way back (they're done). Uncertain travel (dest unreadable) is
 * treated as outbound and allowed — the poller drops them if they turn for home.
 */
export function canEnlistFromStatus(
  state: string,
  description?: string | null,
  details?: string | null,
): boolean {
  if (state === "Abroad") return true;
  if (state === "Traveling") return parseTravelDest(description, details) !== "Torn";
  return false;
}
