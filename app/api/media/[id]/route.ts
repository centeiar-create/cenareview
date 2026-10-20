import { bindings, failure, HttpError, identity, json, ownedAsset, removeAsset, sameOrigin } from "../../../../lib/review-store";
type Context = { params: Promise<{ id: string }> };
export async function serveMedia(request: Request, owner: string, id: string, head = false) {
  try { const asset = await ownedAsset(owner, id);
    if (asset.state === "deleted" || asset.expires_at <= Date.now()) throw new HttpError(410, "Este vídeo foi excluído ou expirou. Os comentários continuam disponíveis.");
    if (asset.state !== "available") throw new HttpError(409, "O envio deste vídeo ainda não foi concluído.");
    let start = 0, end = asset.bytes - 1, partial = false;
    const range = request.headers.get("range");
    if (range) { const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${asset.bytes}`, "Cache-Control": "private, no-store" } });
      if (!match[1]) start = Math.max(0, asset.bytes - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= asset.bytes) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${asset.bytes}`, "Cache-Control": "private, no-store" } });
      partial = true;
    }
    const headers = new Headers({ "Content-Type": asset.mime, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}` });
    if (partial) headers.set("Content-Range", `bytes ${start}-${end}/${asset.bytes}`);
    if (head) return new Response(null, { status: partial ? 206 : 200, headers });
    const object = await bindings().bucket.get(asset.object_key, partial ? { range: { offset: start, length: end - start + 1 } } : undefined);
    if (!object) throw new HttpError(404, "O arquivo não está mais disponível. Os comentários foram preservados.");
    headers.set("ETag", object.httpEtag); return new Response(object.body, { status: partial ? 206 : 200, headers });
  } catch (error) { return failure(error); }
}
export const GET = async (request: Request, context: Context) => serveMedia(request, await identity(request), (await context.params).id);
export const HEAD = async (request: Request, context: Context) => serveMedia(request, await identity(request), (await context.params).id, true);
export async function DELETE(request: Request, context: Context) {
  try { const owner = await identity(request); sameOrigin(request); const asset = await ownedAsset(owner, (await context.params).id); await removeAsset(asset); return json({ removed: true, commentsPreserved: true }); } catch (error) { return failure(error); }
}
