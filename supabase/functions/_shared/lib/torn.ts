// Typed Torn API v2 client. Web-API only (fetch), so it runs unchanged in
// Node (Next.js routes) and Deno (Edge Functions). The key is sent via the
// Authorization header, never in the URL, to keep it out of request logs.
// `baseUrl` is overridable so tests can point at the chain simulator.

export interface TornChain {
  id: number;
  current: number;
  max: number;
  timeout: number;
  modifier: number;
  cooldown: number;
  start: number;
  end: number;
}

export interface TornFactionBasic {
  id: number;
  name: string;
  tag: string;
  leader_id: number;
  co_leader_id: number | null;
  members: number;
  capacity: number;
  respect: number;
  best_chain: number;
}

export interface TornFactionMember {
  id: number;
  name: string;
  level: number;
  days_in_faction: number;
  position: string;
  last_action: { status: string; timestamp: number; relative: string };
  status: { description: string; state: string; color: string; until: number | null };
}

export interface TornAttackParty {
  id: number;
  name: string;
  level: number;
  faction: { id: number; name: string } | null;
}

export interface TornAttack {
  id: number;
  code: string;
  started: number;
  ended: number;
  attacker: TornAttackParty | null; // null when stealthed by an outsider
  defender: TornAttackParty;
  result: string; // "Attacked" | "Mugged" | "Hospitalized" | "Lost" | "Stalemate" | "Escape" | "Assist" | "Interrupted" | "Timeout" | "Special"
  respect_gain: number;
  respect_loss: number;
  chain: number; // chain count at this hit (0 if not a chain hit)
  is_interrupted: boolean;
  is_stealthed: boolean;
  is_raid: boolean;
  is_ranked_war: boolean;
  modifiers: {
    fair_fight: number;
    war: number;
    retaliation: number;
    group: number;
    overseas: number;
    chain: number;
    warlord: number;
  };
}

export interface TornUserBasic {
  id: number;
  name: string;
  level: number;
  gender: string;
  status: { description: string; state: string; color: string; until: number | null };
}

export interface TornKeyInfo {
  access: { level: number; type: string; faction: boolean };
  user: { id: number; faction_id: number; company_id: number };
  selections: Record<string, string[]>;
}

export class TornApiError extends Error {
  constructor(
    public code: number,
    message: string,
    public httpStatus?: number,
  ) {
    super(`Torn API error ${code}: ${message}`);
    this.name = "TornApiError";
  }
}

/** Key is wrong/expired/disabled — quarantine it and make the member re-login. */
export function isInvalidKeyError(e: unknown): boolean {
  return e instanceof TornApiError && [1, 2, 10, 13, 16, 18].includes(e.code);
}

/** Too many requests for this key's owner (100/min per user). Back off. */
export function isRateLimitError(e: unknown): boolean {
  return e instanceof TornApiError && e.code === 5;
}

export const DEFAULT_TORN_API_BASE = "https://api.torn.com/v2";

export interface TornClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export function makeTornClient(opts: TornClientOptions) {
  const base = (opts.baseUrl ?? DEFAULT_TORN_API_BASE).replace(/\/$/, "");
  const doFetch = opts.fetchFn ?? fetch;

  async function call<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
    // Torn serves identical requests from a ~30s cache; a changing timestamp
    // makes each request unique (the officially documented bypass). Without
    // this, a 15s poller would read chain timers up to 30s stale.
    url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
    // Shows as the requester in the key owner's own key-usage audit log.
    url.searchParams.set("comment", "ChainWatch");
    const res = await doFetch(url.toString(), {
      headers: { Authorization: `ApiKey ${opts.apiKey}` },
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TornApiError(-1, `non-JSON response (HTTP ${res.status})`, res.status);
    }
    const err = (body as { error?: { code: number; error: string } }).error;
    if (err) throw new TornApiError(err.code, err.error, res.status);
    if (!res.ok) throw new TornApiError(-1, `HTTP ${res.status}`, res.status);
    return body as T;
  }

  return {
    keyInfo: () => call<{ info: TornKeyInfo }>("/key/info").then((r) => r.info),
    userBasic: () => call<{ profile: TornUserBasic }>("/user/basic").then((r) => r.profile),
    factionBasic: () => call<{ basic: TornFactionBasic }>("/faction/basic").then((r) => r.basic),
    factionChain: () => call<{ chain: TornChain }>("/faction/chain").then((r) => r.chain),
    factionMembers: () =>
      call<{ members: TornFactionMember[] }>("/faction/members").then((r) => r.members),
    userAttacks: (params: { from?: number; to?: number; limit?: number; sort?: "asc" | "desc" }) =>
      call<{ attacks: TornAttack[] }>("/user/attacks", {
        ...(params.from !== undefined ? { from: params.from } : {}),
        ...(params.to !== undefined ? { to: params.to } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.sort !== undefined ? { sort: params.sort } : {}),
      }).then((r) => r.attacks),
  };
}

export type TornClient = ReturnType<typeof makeTornClient>;
