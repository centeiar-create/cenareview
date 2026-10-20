import { bindings, cleanup, failure, HttpError, identity, json, sameOrigin, storageInfo, validateWorkspace } from "../../../lib/review-store";
import { commitWorkspace, mergeChanges, readWorkspace, type Workspace } from "../../../lib/workspace";
export async function GET(request: Request) {
  try { const owner = await identity(request); await cleanup(owner);
    return json({...await readWorkspace(owner),storage:await storageInfo(owner)});
  } catch (error) { return failure(error); }
}
export async function PUT(request: Request) {
  try {
    const owner = await identity(request); sameOrigin(request);
    const text = await request.text();
    if (text.length > 3500000) throw new HttpError(413, "Revisão muito grande.");
    const body = JSON.parse(text) as {state: Workspace; base?: Workspace; revision: number};
    validateWorkspace(body.state); if (body.base) validateWorkspace(body.base);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw new HttpError(400, "Revisão de sincronização inválida.");
    const ids = [...new Set(body.state.projects.flatMap(p => p.versions.filter(v => v.type === "hosted").map(v => v.mediaId!)))];
    for (const id of ids) if (!await bindings().db.prepare("SELECT id FROM media_assets WHERE id=? AND owner=?").bind(id,owner).first()) throw new HttpError(400, "O vídeo não pertence a esta área de revisão.");
    for (let attempt=0; attempt<6; attempt++) {
      const current = await readWorkspace(owner);
      if (!body.base && body.revision !== current.revision) throw new HttpError(409, "A revisão foi alterada. Atualize a página antes de salvar.");
      const state = current.state && body.base ? mergeChanges(body.base,body.state,current.state) as Workspace : body.state;
      if (await commitWorkspace(owner,state,current.revision)) return json({state,revision:current.revision+1});
    }
    throw new HttpError(409, "A revisão recebeu outras mudanças. Tente salvar novamente.");
  } catch (error) { return failure(error); }
}
