import { decryptApiKey, encryptApiKey } from "@/supabase/functions/_shared/lib/crypto";

function encKey(): string {
  const k = process.env.API_KEY_ENC_KEY;
  if (!k) throw new Error("API_KEY_ENC_KEY is not set");
  return k;
}

export function encryptKey(plaintext: string) {
  return encryptApiKey(plaintext, encKey());
}

export function decryptKey(ct: string, iv: string) {
  return decryptApiKey(ct, iv, encKey());
}
