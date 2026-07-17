import { makeTornClient } from "@/supabase/functions/_shared/lib/torn";

export * from "@/supabase/functions/_shared/lib/torn";

/** Client bound to TORN_API_BASE (overridable for the chain simulator). */
export function tornClient(apiKey: string) {
  return makeTornClient({ apiKey, baseUrl: process.env.TORN_API_BASE });
}
