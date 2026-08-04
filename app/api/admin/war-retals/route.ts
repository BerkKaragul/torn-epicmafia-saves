import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, sessionMember, unauthorized } from "@/lib/session";
import { decryptKey } from "@/lib/crypto";
import { isRateLimitError, TornApiError, tornClient, type TornAttack } from "@/lib/torn";

// Paging the whole war window can take a while (rate limit is 100/min).
export const maxDuration = 300;

const PAGE = 100;
const MAX_PAGES = 150;
const DELAY_MS = 700; // keep us under 100 requests/min on the caller's key

// A qualifying war retal (same rule as the community userscript): a ranked-war
// hospitalization on the enemy war faction that carried both a war and a
// retaliation bonus.
function isWarRetal(a: TornAttack, ourFaction: number, opponent: number): boolean {
  return (
    a.is_ranked_war === true &&
    a.result === "Hospitalized" &&
    a.attacker?.faction?.id === ourFaction &&
    a.defender?.faction?.id === opponent &&
    Number(a.modifiers?.war) > 1 &&
    Number(a.modifiers?.retaliation) > 1
  );
}

// a ranked-war assist on the enemy war faction (chain reports miss non-chain
// assists, so we count them here for the full total)
function isWarAssist(a: TornAttack, ourFaction: number, opponent: number): boolean {
  return (
    a.is_ranked_war === true &&
    a.result === "Assist" &&
    a.attacker?.faction?.id === ourFaction &&
    a.defender?.faction?.id === opponent
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// POST { war_id } → counts each member's war retals from /faction/attacks and
// stores them for that war. Uses the calling admin's own key (must have faction
// API access).
export async function POST(req: Request) {
  const member = await sessionMember();
  if (!member) return unauthorized();
  if (!member.is_admin) return forbidden();

  let warId: number;
  try {
    warId = Number((await req.json()).war_id);
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (!Number.isInteger(warId)) {
    return NextResponse.json({ error: "Invalid war" }, { status: 400 });
  }
  if (!member.api_key_ct || !member.api_key_iv) {
    return NextResponse.json({ error: "No API key on your account — log in again." }, { status: 400 });
  }

  const [{ data: war }, { data: settings }] = await Promise.all([
    db()
      .from("wars")
      .select("torn_war_id, opponent_id, started_at, ended_at")
      .eq("torn_war_id", warId)
      .maybeSingle(),
    db().from("settings").select("faction_id").eq("id", 1).single(),
  ]);
  if (!war) return NextResponse.json({ error: "War not found" }, { status: 404 });
  if (!settings) return NextResponse.json({ error: "Settings missing" }, { status: 500 });

  const ourFaction = Number(settings.faction_id);
  const opponent = Number(war.opponent_id);
  if (!opponent) {
    return NextResponse.json({ error: "No opponent recorded for this war yet." }, { status: 400 });
  }
  const fromS = Math.floor(new Date(war.started_at).getTime() / 1000);
  const toS = war.ended_at
    ? Math.floor(new Date(war.ended_at).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  let key: string;
  try {
    key = await decryptKey(member.api_key_ct, member.api_key_iv);
  } catch {
    return NextResponse.json({ error: "Couldn't read your API key — log in again." }, { status: 400 });
  }
  const torn = tornClient(key);

  const tally = new Map<number, { retals: number; assists: number; respect: number }>();
  const seen = new Set<number>();
  let cursor = toS;
  let pages = 0;
  let scanned = 0;
  let capped = false;

  try {
    while (pages < MAX_PAGES) {
      const attacks = await torn.factionAttacks({
        filters: "outgoing",
        limit: PAGE,
        sort: "DESC",
        from: fromS,
        to: cursor,
      });
      pages += 1;
      if (attacks.length === 0) break;

      let oldest = cursor;
      let added = 0;
      for (const a of attacks) {
        if (!Number.isFinite(a.id) || seen.has(a.id)) continue;
        seen.add(a.id);
        added += 1;
        scanned += 1;
        const ts = Number(a.ended || a.started || 0);
        if (ts && ts < oldest) oldest = ts;
        if (!a.attacker) continue;
        const retal = isWarRetal(a, ourFaction, opponent);
        const assist = isWarAssist(a, ourFaction, opponent);
        if (retal || assist) {
          const t = tally.get(a.attacker.id) ?? { retals: 0, assists: 0, respect: 0 };
          if (retal) {
            t.retals += 1;
            t.respect += Number(a.respect_gain || 0);
          }
          if (assist) t.assists += 1;
          tally.set(a.attacker.id, t);
        }
      }

      if (attacks.length < PAGE || added === 0) break; // last page / nothing new
      const next = oldest < cursor ? oldest : cursor - 1; // always make progress
      if (next < fromS) break;
      cursor = next;
      if (pages >= MAX_PAGES) {
        capped = true;
        break;
      }
      await sleep(DELAY_MS);
    }
  } catch (e) {
    if (isRateLimitError(e)) {
      return NextResponse.json(
        { error: "Torn rate limit hit mid-fetch — wait a minute and try again." },
        { status: 429 },
      );
    }
    if (e instanceof TornApiError) {
      const msg =
        e.code === 16
          ? "Your key can't read faction attacks — you need faction API access (ask a leader to grant it)."
          : `Torn API error: ${e.message}`;
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error("war-retals fetch failed", e);
    return NextResponse.json({ error: "Fetch failed — try again." }, { status: 500 });
  }

  // replace this war's stored counts with the fresh tally
  await db().from("war_retals").delete().eq("torn_war_id", warId);
  const rows = [...tally.entries()].map(([member_id, t]) => ({
    torn_war_id: warId,
    member_id,
    retals: t.retals,
    assists: t.assists,
    respect: Math.round(t.respect),
  }));
  if (rows.length) {
    const { error } = await db().from("war_retals").insert(rows);
    if (error) {
      console.error("war_retals insert failed", error);
      return NextResponse.json({ error: "Counted, but saving failed." }, { status: 500 });
    }
  }
  // mark the war so these faction-attacks counts become authoritative
  await db().from("wars").update({ retals_synced: true }).eq("torn_war_id", warId);

  return NextResponse.json({
    ok: true,
    members: rows.length,
    retals: rows.reduce((s, r) => s + r.retals, 0),
    assists: rows.reduce((s, r) => s + r.assists, 0),
    scanned,
    pages,
    capped,
  });
}
