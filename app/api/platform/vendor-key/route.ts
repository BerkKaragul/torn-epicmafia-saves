import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encryptKey } from "@/lib/crypto";
import { requireMember } from "@/lib/session";
import { TornApiError, tornClient } from "@/lib/torn";
import { storedVendorKey, vendorPreview } from "@/lib/vendor";

const tornError = (e: unknown) =>
  e instanceof TornApiError
    ? NextResponse.json({ error: `Torn API error: ${e.message}` }, { status: 400 })
    : NextResponse.json(
        { error: e instanceof Error ? e.message : "Failed" },
        { status: 500 },
      );

// POST { apiKey } → verify and store the vendor's Full Access key (the account
// that receives Xanax), and return a preview of what billing would read.
export async function POST(req: Request) {
  const auth = await requireMember({ owner: true });
  if (auth.error) return auth.error;

  let apiKey: unknown;
  try {
    ({ apiKey } = await req.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (typeof apiKey !== "string" || !/^[a-zA-Z0-9]{16}$/.test(apiKey.trim())) {
    return NextResponse.json({ error: "Not a Torn API key" }, { status: 400 });
  }
  const key = apiKey.trim();

  try {
    const torn = tornClient(key);
    const info = await torn.keyInfo();
    const canReadLogs =
      info.access.type === "Full Access" || (info.selections?.user ?? []).includes("log");
    if (!canReadLogs) {
      return NextResponse.json(
        { error: "Reading item logs needs a Full Access key (or a custom key with user → log)." },
        { status: 400 },
      );
    }
    const [profile, { data: cfg }] = await Promise.all([
      torn.userBasic(),
      db().from("platform_config").select("xanax_item_id").eq("id", 1).single(),
    ]);
    const preview = await vendorPreview(key, cfg?.xanax_item_id ?? 206);

    const { ct, iv } = await encryptKey(key);
    const { error } = await db()
      .from("platform_config")
      .update({
        vendor_torn_id: profile.id,
        vendor_name: profile.name,
        vendor_key_ct: ct,
        vendor_key_iv: iv,
        vendor_key_valid: true,
        receive_log_type_ids: preview.receive_log_type_ids,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (error) throw error;
    return NextResponse.json({ ok: true, vendor: { id: profile.id, name: profile.name }, preview });
  } catch (e) {
    return tornError(e);
  }
}

// GET → re-run the preview with the stored key (nothing is recorded)
export async function GET() {
  const auth = await requireMember({ owner: true });
  if (auth.error) return auth.error;
  try {
    const stored = await storedVendorKey();
    if (!stored) return NextResponse.json({ error: "No vendor key saved yet." }, { status: 404 });
    return NextResponse.json({
      preview: await vendorPreview(stored.key, stored.itemId, stored.typeIds),
    });
  } catch (e) {
    return tornError(e);
  }
}
