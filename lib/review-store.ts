import { adminIdentity, runtime } from "./access";
export const MAX_VIDEO_BYTES = 100_000_000;
export const QUOTA_BYTES = 1_000_000_000;
export const RETENTION_DAYS = 30;
const MAX_ACTIVE_FILES = 200;
type AssetRow = { id: string; owner: string; object_key: string; name: string; mime: string; bytes: number; created_at: number; expires_at: number; state: string; deleted_at: number | null };
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function bindings() {
  const env = runtime();
  if (!env.DB || !env.BUCKET) throw new HttpError(503, "O armazenamento está sendo preparado. Tente novamente em alguns instantes.");
  return { db: env.DB, bucket: env.BUCKET };
}
export const identity = adminIdentity;
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "Origem da solicitação não autorizada.");
}
export function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } }); }
export function failure(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  console.error("Review operation failed", error instanceof Error ? error.message : "Unknown failure");
  return json({ error: "Não foi possível concluir a operação. Tente novamente." }, 500);
}
export async function storageInfo(owner: string) {
  const db = bindings().db;
  const [active, recent] = await Promise.all([
    db.prepare("SELECT * FROM media_assets WHERE owner=? AND state!='deleted' ORDER BY created_at DESC").bind(owner).all<AssetRow>(),
    db.prepare("SELECT * FROM media_assets WHERE owner=? AND state='deleted' ORDER BY created_at DESC LIMIT 200").bind(owner).all<AssetRow>(),
  ]);
  const assets = [...active.results, ...recent.results].sort((a,b)=>b.created_at-a.created_at);
  const now = Date.now();
  return { limitBytes: QUOTA_BYTES, maxVideoBytes: MAX_VIDEO_BYTES, retentionDays: RETENTION_DAYS,
    usedBytes: active.results.reduce((s, a) => s + a.bytes, 0),
    assets: assets.map(a => ({ id: a.id, name: a.name, bytes: a.bytes, mime: a.mime, createdAt: a.created_at, expiresAt: a.expires_at,
      status: a.state === "deleted" ? "deleted" : a.expires_at <= now ? "expired" : a.state })) };
}
export async function removeAsset(asset: Pick<AssetRow, "id" | "owner" | "object_key">) {
  const { db, bucket } = bindings(); await bucket.delete(asset.object_key);
  await db.prepare("UPDATE media_assets SET state='deleted',deleted_at=? WHERE id=? AND owner=? AND state!='deleted'").bind(Date.now(), asset.id, asset.owner).run();
}
export async function cleanup(owner?: string, limit = 20) {
  const { db } = bindings(); const now = Date.now();
  const filter = "((state='available' AND expires_at<=?) OR (state='reserved' AND created_at<=?))";
  const query = `SELECT * FROM media_assets WHERE ${filter}${owner ? " AND owner=?" : ""} LIMIT ?`;
  const values: (string | number)[] = [now, now - 3_600_000, ...(owner ? [owner] : []), limit];
  const rows = await db.prepare(query).bind(...values).all<AssetRow>();
  let removed = 0, failed = 0;
  for (const asset of rows.results) { try { await removeAsset(asset); removed++; } catch { failed++; } }
  const count = await db.prepare(`SELECT count(*) AS n FROM media_assets WHERE ${filter}${owner ? " AND owner=?" : ""}`).bind(now, now - 3_600_000, ...(owner ? [owner] : [])).first<{ n: number }>();
  return { checked: rows.results.length, removed, failed, remaining: count?.n || 0 };
}
export async function reserveUpload(owner: string, name: string, mime: string, bytes: number) {
  const { db } = bindings();
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_VIDEO_BYTES) throw new HttpError(413, "O vídeo deve ter até 100 MB.");
  if (!["video/mp4", "video/webm", "video/quicktime"].includes(mime)) throw new HttpError(415, "Use MP4, WebM ou MOV. MP4 com H.264 oferece maior compatibilidade.");
  await cleanup(owner);
  const id = crypto.randomUUID(), now = Date.now(), key = `review-videos/${id}`, expiresAt = now + RETENTION_DAYS * 86_400_000;
  // Atomic conditional INSERT includes reservations in the quota calculation.
  const result = await db.prepare(`INSERT INTO media_assets (id,owner,object_key,name,mime,bytes,created_at,expires_at,state)
    SELECT ?,?,?,?,?,?,?,?,'reserved'
    WHERE (SELECT COALESCE(sum(bytes),0) FROM media_assets WHERE owner=? AND state!='deleted') + ? <= ?
    AND (SELECT count(*) FROM media_assets WHERE owner=? AND state!='deleted') < ?`)
    .bind(id, owner, key, name.slice(0,200), mime, bytes, now, expiresAt, owner, bytes, QUOTA_BYTES, owner, MAX_ACTIVE_FILES).run();
  if (!result.meta.changes) throw new HttpError(413, "O espaço disponível é insuficiente ou o limite de 200 vídeos ativos foi atingido. Exclua um arquivo antes de continuar.");
  return { id, key, owner, name: name.slice(0,200), mime, bytes, createdAt: now, expiresAt };
}
export async function ownedAsset(owner: string, id: string): Promise<AssetRow> {
  if (!/^[a-zA-Z0-9-]{10,100}$/.test(id)) throw new HttpError(404, "Vídeo não encontrado.");
  const asset = await bindings().db.prepare("SELECT * FROM media_assets WHERE id=? AND owner=?").bind(id, owner).first<AssetRow>();
  if (!asset) throw new HttpError(404, "Vídeo não encontrado."); return asset;
}
export function validateWorkspace(raw: unknown): string {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "Revisão inválida.");
  const s = raw as Record<string, unknown>, data = JSON.stringify(s);
  if (data.length > 1_500_000 || s.schemaVersion !== 1 || !Array.isArray(s.projects) || s.projects.length > 200) throw new HttpError(413, "A revisão excedeu o limite de dados.");
  let count = 0;
  for (const project of s.projects) {
    if (typeof project.id !== "string" || typeof project.name !== "string" || project.name.length > 200 || !Array.isArray(project.versions) || project.versions.length > 100) throw new HttpError(400, "Projeto inválido.");
    for (const v of project.versions) {
      if (typeof v.id !== "string" || typeof v.title !== "string" || v.title.length > 220 || !["demo", "hosted", "local"].includes(v.type) || !Array.isArray(v.comments)) throw new HttpError(400, "Versão inválida.");
      if (v.type === "hosted" && (typeof v.mediaId !== "string" || !/^[a-zA-Z0-9-]{10,100}$/.test(v.mediaId))) throw new HttpError(400, "Referência de vídeo inválida.");
      count += v.comments.length;
      if (count > 5000) throw new HttpError(413, "O limite é de 5.000 comentários por área de revisão.");
      for (const c of v.comments) {
        if (typeof c.id !== "string" || typeof c.text !== "string" || c.text.length > 4000 || !["point", "range", "general"].includes(c.mode) || !Number.isFinite(c.time) || c.time < 0 || c.time > 86400 || (c.mode === "range" && (!Number.isFinite(c.end) || c.end <= c.time || c.end > 86400)) || !Array.isArray(c.replies) || c.replies.length > 100) throw new HttpError(400, "Comentário inválido.");
        for (const r of c.replies) if (typeof r.text !== "string" || r.text.length > 2000) throw new HttpError(400, "Resposta inválida.");
      }
    }
  }
  return data;
}
