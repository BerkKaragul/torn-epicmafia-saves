// Generates the VAPID key pair for web push. Run once: node scripts/generate-vapid.mjs
// - VAPID_KEYS goes into the Supabase function secrets (used to SIGN pushes)
// - NEXT_PUBLIC_VAPID_PUBLIC_KEY goes into Vercel env (used by browsers to subscribe)

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const raw = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey));

console.log("VAPID_KEYS=" + JSON.stringify({ publicKey: publicJwk, privateKey: privateJwk }));
console.log("");
console.log("NEXT_PUBLIC_VAPID_PUBLIC_KEY=" + raw.toString("base64url"));
