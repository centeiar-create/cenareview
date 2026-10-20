import { bindings, failure, HttpError, identity, json, removeAsset, reserveUpload, sameOrigin } from "../../../lib/review-store";
export async function POST(request: Request) {
  let reserved: Awaited<ReturnType<typeof reserveUpload>> | null = null;
  try { const owner = await identity(request); sameOrigin(request);
    const bytes = Number(request.headers.get("x-file-size")), length = request.headers.get("content-length");
    if (length && Number(length) !== bytes) throw new HttpError(400, "O tamanho recebido não corresponde ao arquivo.");
    if (!request.body) throw new HttpError(400, "Selecione um arquivo de vídeo.");
    let name: string; try { name = decodeURIComponent(request.headers.get("x-file-name") || "video.mp4"); } catch { throw new HttpError(400, "Nome de arquivo inválido."); }
    const mime = request.headers.get("x-video-type") || "video/mp4";
    reserved = await reserveUpload(owner, name, mime, bytes);
    const { bucket, db } = bindings();
    // Stream directly to R2 without buffering the whole video in memory.
    const object = await bucket.put(reserved.key, request.body, { httpMetadata: { contentType: mime }, customMetadata: { expiresAt: String(reserved.expiresAt), mediaId: reserved.id } });
    if (!object || object.size !== bytes) throw new HttpError(400, "O envio foi interrompido ou o tamanho do arquivo não corresponde ao informado.");
    const result = await db.prepare("UPDATE media_assets SET state='available' WHERE id=? AND owner=? AND state='reserved'").bind(reserved.id, owner).run();
    if (!result.meta.changes) throw new HttpError(410, "O envio expirou. Tente novamente.");
    return json({ asset: { id: reserved.id, name: reserved.name, bytes, mime, createdAt: reserved.createdAt, expiresAt: reserved.expiresAt, status: "available" } }, 201);
  } catch (error) { if (reserved) { try { await removeAsset({ id: reserved.id, owner: reserved.owner, object_key: reserved.key }); } catch { /* reservation remains counted until cleanup */ } } return failure(error); }
}
