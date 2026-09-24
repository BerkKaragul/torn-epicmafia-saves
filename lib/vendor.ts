import { decryptKey } from "@/lib/crypto";
import { db } from "@/lib/db";
import { tornClient, type TornUserLog } from "@/lib/torn";
import {
  findReceiveLogTypes,
  parseItemReceive,
  type ParsedReceipt,
} from "@/supabase/functions/_shared/logic/billing";

export interface VendorPreview {
  receive_log_type_ids: number[];
  /** what the billing sweep would make of the most recent receipts */
  receipts: ParsedReceipt[];
  /** a few raw entries, so the operator can check the parser against reality */
  raw: TornUserLog[];
}

/**
 * Reads the vendor's recent item-receive logs and runs them through the same
 * parser the poller uses, without recording anything.
 */
export async function vendorPreview(apiKey: string, itemId: number, typeIds?: number[]) {
  const torn = tornClient(apiKey);
  const ids = typeIds?.length ? typeIds : findReceiveLogTypes(await torn.logTypes());
  if (ids.length === 0) {
    throw new Error("Torn's log type list has no 'item receive' entry — can't read payments.");
  }
  const logs = await torn.userLog({ log: ids, limit: 25 });
  const receipts = logs
    .map((l) => parseItemReceive(l, itemId))
    .filter((r): r is ParsedReceipt => r !== null);
  return { receive_log_type_ids: ids, receipts, raw: logs.slice(0, 3) } satisfies VendorPreview;
}

/** The stored vendor key, decrypted (server-side only). */
export async function storedVendorKey(): Promise<{ key: string; itemId: number; typeIds: number[] } | null> {
  const { data } = await db()
    .from("platform_config")
    .select("vendor_key_ct, vendor_key_iv, xanax_item_id, receive_log_type_ids")
    .eq("id", 1)
    .single();
  if (!data?.vendor_key_ct || !data.vendor_key_iv) return null;
  return {
    key: await decryptKey(data.vendor_key_ct, data.vendor_key_iv),
    itemId: data.xanax_item_id,
    typeIds: data.receive_log_type_ids ?? [],
  };
}
