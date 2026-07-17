import { describe, expect, test } from "vitest";
import {
  decryptApiKey,
  encryptApiKey,
  generateEncKeyB64,
} from "../supabase/functions/_shared/lib/crypto.ts";

describe("API key encryption (AES-256-GCM)", () => {
  test("round-trips a Torn API key", async () => {
    const encKey = await generateEncKeyB64();
    const { ct, iv } = await encryptApiKey("AbCd1234EfGh5678", encKey);
    expect(await decryptApiKey(ct, iv, encKey)).toBe("AbCd1234EfGh5678");
  });

  test("produces a fresh IV per encryption (no ciphertext reuse)", async () => {
    const encKey = await generateEncKeyB64();
    const a = await encryptApiKey("AbCd1234EfGh5678", encKey);
    const b = await encryptApiKey("AbCd1234EfGh5678", encKey);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  test("rejects tampered ciphertext", async () => {
    const encKey = await generateEncKeyB64();
    const { ct, iv } = await encryptApiKey("AbCd1234EfGh5678", encKey);
    const tampered = ct.slice(0, -4) + (ct.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(decryptApiKey(tampered, iv, encKey)).rejects.toThrow();
  });

  test("rejects decryption with the wrong key", async () => {
    const { ct, iv } = await encryptApiKey("AbCd1234EfGh5678", await generateEncKeyB64());
    await expect(decryptApiKey(ct, iv, await generateEncKeyB64())).rejects.toThrow();
  });
});
