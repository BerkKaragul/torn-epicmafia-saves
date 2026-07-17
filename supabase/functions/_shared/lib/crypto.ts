// AES-256-GCM encryption for stored Torn API keys. Web Crypto only, so the
// same module runs in Node (Next.js API routes) and Deno (Edge Functions).
// The 256-bit key comes from the API_KEY_ENC_KEY env var (base64), which must
// be set identically on Vercel and in the Supabase function secrets.

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function importKey(encKeyB64: string): Promise<CryptoKey> {
  const raw = b64decode(encKeyB64);
  if (raw.length !== 32) throw new Error("API_KEY_ENC_KEY must be 32 bytes of base64");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptApiKey(
  plaintext: string,
  encKeyB64: string,
): Promise<{ ct: string; iv: string }> {
  const key = await importKey(encKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ct: b64encode(new Uint8Array(ct)), iv: b64encode(iv) };
}

export async function decryptApiKey(
  ctB64: string,
  ivB64: string,
  encKeyB64: string,
): Promise<string> {
  const key = await importKey(encKeyB64);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(ivB64) as BufferSource },
    key,
    b64decode(ctB64) as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

/** Generate a fresh base64 256-bit key (setup tooling + tests). */
export async function generateEncKeyB64(): Promise<string> {
  return b64encode(crypto.getRandomValues(new Uint8Array(32)));
}
