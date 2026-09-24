import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encryptKey } from "@/lib/crypto";
import { createSessionCookie } from "@/lib/session";
import { TornApiError, tornClient } from "@/lib/torn";

async function rateLimited(ip: string): Promise<boolean> {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await db()
    .from("login_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .gte("at", since);
  await db().from("login_attempts").insert({ ip });
  return (count ?? 0) >= 15;
}

// Any member of any faction can sign in. The first login from a faction
// registers it (and grants the platform's free trial, if one is configured);
// whether the faction can actually USE the app is decided by its subscription.
export async function POST(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (await rateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many attempts — wait a few minutes." },
      { status: 429 },
    );
  }

  let apiKey: unknown;
  try {
    ({ apiKey } = await req.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (typeof apiKey !== "string" || !/^[a-zA-Z0-9]{16}$/.test(apiKey.trim())) {
    return NextResponse.json(
      { error: "That doesn't look like a Torn API key (16 letters/numbers)." },
      { status: 400 },
    );
  }
  const key = apiKey.trim();
  const torn = tornClient(key);

  try {
    const info = await torn.keyInfo();
    // user/attacks needs Limited+; a Custom key qualifies if it has the selection
    if (!info.selections?.user?.includes("attacks")) {
      return NextResponse.json(
        {
          error:
            "This key can't read your attacks. Create a Limited Access key (or a custom key with the 'attacks' selection).",
        },
        { status: 400 },
      );
    }

    const [profile, faction] = await Promise.all([torn.userBasic(), torn.factionBasic()]);
    if (!faction?.id) {
      return NextResponse.json(
        { error: "You need to be in a faction to use ChainWatch." },
        { status: 400 },
      );
    }

    // register the faction on first sight; refresh its name/tag otherwise
    const { error: facErr } = await db().rpc("ensure_faction", {
      p_faction: faction.id,
      p_name: faction.name,
      p_tag: faction.tag,
    });
    if (facErr) throw facErr;
    const { data: trial } = await db().rpc("grant_trial", { p_faction: faction.id });

    const { ct, iv } = await encryptKey(key);
    const isLeader = profile.id === faction.leader_id || profile.id === faction.co_leader_id;

    const { data: existing } = await db()
      .from("members")
      .select("faction_id, is_admin, admin_source")
      .eq("torn_id", profile.id)
      .maybeSingle();
    // admin rights belong to a faction: a member who moved starts fresh
    const sameFaction = existing?.faction_id === faction.id;
    const keptAdmin = sameFaction ? (existing?.is_admin ?? false) : false;
    const keptSource = sameFaction ? (existing?.admin_source ?? null) : null;

    if (existing && !sameFaction) {
      await db()
        .from("shifts")
        .update({ ended_at: new Date().toISOString(), end_reason: "left_faction" })
        .eq("member_id", profile.id)
        .is("ended_at", null);
    }

    const { error: upsertErr } = await db()
      .from("members")
      .upsert({
        torn_id: profile.id,
        faction_id: faction.id,
        name: profile.name,
        api_key_ct: ct,
        api_key_iv: iv,
        key_access_level: info.access.type,
        key_valid: true,
        rate_limited_until: null,
        // leaders are always admins; never downgrade an existing granted admin
        is_admin: isLeader || keptAdmin,
        admin_source: isLeader ? "auto" : keptSource,
        last_login_at: new Date().toISOString(),
      });
    if (upsertErr) throw upsertErr;

    // keep leadership + a default poller key up to date
    const { data: settings } = await db()
      .from("settings")
      .select("poller_member_id")
      .eq("faction_id", faction.id)
      .single();
    await db()
      .from("settings")
      .update({
        leader_id: faction.leader_id,
        co_leader_id: faction.co_leader_id,
        poller_member_id: settings?.poller_member_id ?? profile.id,
        updated_at: new Date().toISOString(),
      })
      .eq("faction_id", faction.id);

    await createSessionCookie(profile.id);
    return NextResponse.json({
      ok: true,
      member: {
        torn_id: profile.id,
        name: profile.name,
        is_admin: isLeader || keptAdmin,
      },
      trial_started: Boolean(trial?.faction_id),
    });
  } catch (e) {
    if (e instanceof TornApiError) {
      const friendly =
        e.code === 5
          ? "Torn rate limit hit — wait a minute and try again."
          : e.code === 2
            ? "Torn says that key is incorrect — check it and try again."
            : `Torn API error: ${e.message}`;
      return NextResponse.json({ error: friendly }, { status: 400 });
    }
    console.error("login failed", e);
    return NextResponse.json({ error: "Login failed — try again." }, { status: 500 });
  }
}
