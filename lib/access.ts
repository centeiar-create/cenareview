import { env } from "cloudflare:workers";
import { HttpError } from "./review-store";

export type RuntimeEnv = {
  DB: D1Database; BUCKET: R2Bucket; ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; OWNER_EMAIL: string;
};
export const runtime = () => env as unknown as RuntimeEnv;
type AccessKey = JsonWebKey & {kid: string};
let cached: {issuer: string; until: number; keys: AccessKey[]} | undefined;
function decode(input: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw Error("Invalid encoding");
  return Uint8Array.from(atob(input.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
}

export async function adminIdentity(request: Request): Promise<string> {
  const settings = runtime();
  const team = settings.ACCESS_TEAM_DOMAIN?.replace(/^https:\/\//, "").replace(/\/$/, "");
  if (!team || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !settings.ACCESS_AUD || !settings.OWNER_EMAIL) {
    throw new HttpError(503, "O acesso administrativo ainda precisa ser configurado na Cloudflare.");
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16000) throw new HttpError(401, "Entre no acesso administrativo para continuar.");
  try {
    const parts = token.split("."); if (parts.length !== 3) throw Error("Invalid token");
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw Error("Invalid algorithm");
    const issuer = `https://${team}`, now = Date.now();
    if (!cached || cached.issuer !== issuer || cached.until < now || !cached.keys.some(k => k.kid === header.kid)) {
      const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {signal: AbortSignal.timeout(5000)});
      if (!response.ok) throw Error("Keys unavailable");
      const keys = await response.json() as {keys: AccessKey[]};
      if (!Array.isArray(keys.keys) || keys.keys.length > 30) throw Error("Invalid keys");
      cached = {issuer, until: now + 300000, keys: keys.keys};
    }
    const jwk = cached.keys.find(k => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) throw Error("Unknown key");
    const key = await crypto.subtle.importKey("jwk", jwk, {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw Error("Invalid signature");
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== issuer || !aud.includes(settings.ACCESS_AUD) || typeof payload.exp !== "number" || payload.exp * 1000 <= now || (payload.nbf && payload.nbf * 1000 > now + 5000) || typeof payload.email !== "string" || payload.email.toLowerCase() !== settings.OWNER_EMAIL.toLowerCase()) throw Error("Unauthorized identity");
    return "cena-owner";
  } catch {
    throw new HttpError(401, "A sessão administrativa não é válida. Entre novamente.");
  }
}
