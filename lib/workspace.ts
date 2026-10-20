import { bindings, HttpError, validateWorkspace } from "./review-store";

export type Comment = {
  id: string; text: string; time: number; mode: "point" | "range" | "general"; end: number | null;
  author: string; authorEmail?: string; reviewerId?: string; category: string;
  priority: string; assignee: string; done: boolean; createdAt: string; replies: Reply[];
};
export type Reply = {id: string; author: string; authorEmail?: string; reviewerId?: string; text: string; createdAt: string};
export type Version = {id: string; title: string; type: string; mediaId?: string; duration?: number; approvedAt?: string | null; comments: Comment[]};
export type Project = {id: string; name: string; client?: string; versions: Version[]};
export type Workspace = {schemaVersion: 1; author: string; projects: Project[]; activeProject: string; activeVersion: string};
export async function readWorkspace(owner: string) {
  const row = await bindings().db.prepare("SELECT state_json,revision FROM review_workspaces WHERE owner=?").bind(owner).first<{state_json: string; revision: number}>();
  return {state: row ? JSON.parse(row.state_json) as Workspace : null, revision: row?.revision || 0};
}
export async function commitWorkspace(owner: string, state: Workspace, revision: number) {
  const encoded = validateWorkspace(state), {db} = bindings(), now = Date.now();
  if (!revision) return !!await db.prepare("INSERT OR IGNORE INTO review_workspaces (owner,state_json,revision,updated_at) VALUES(?,?,1,?) RETURNING revision").bind(owner, encoded, now).first();
  return !!await db.prepare("UPDATE review_workspaces SET state_json=?,revision=revision+1,updated_at=? WHERE owner=? AND revision=? RETURNING revision").bind(encoded, now, owner, revision).first();
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
// Unchanged data comes from the server: an owner's open tab cannot erase a
// new reviewer's comment. Conflicting edits to the same field require review.
export function mergeChanges(base: unknown, proposed: unknown, current: unknown, path = ""): unknown {
  if (equal(proposed, base)) return current;
  if (equal(current, base) || equal(proposed, current)) return proposed;
  if (Array.isArray(base) && Array.isArray(proposed) && Array.isArray(current) && [...base,...proposed,...current].every(x => record(x) && typeof x.id === "string")) {
    const b = new Map(base.map(x => [x.id,x])), p = new Map(proposed.map(x => [x.id,x])), c = new Map(current.map(x => [x.id,x]));
    const ids = [...new Set([...current,...proposed].map(x => x.id))];
    return ids.map(id => mergeChanges(b.get(id),p.get(id),c.get(id),`${path}/${id}`)).filter(x => x !== undefined);
  }
  if (record(base) && record(proposed) && record(current)) {
    return Object.fromEntries([...new Set([...Object.keys(base),...Object.keys(proposed),...Object.keys(current)])].map(key => [key,
      ["activeProject","activeVersion","author"].includes(key) && path === "" ? proposed[key] : mergeChanges(base[key],proposed[key],current[key],`${path}/${key}`)
    ]).filter(([,value]) => value !== undefined));
  }
  throw new HttpError(409, "Este ajuste foi alterado por outra pessoa. Atualize a página para conferir a mudança; seu texto permanece no campo.");
}
export async function mutateWorkspace<T>(owner: string, mutate: (state: Workspace) => T, authorize?: () => Promise<unknown>) {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (authorize) await authorize();
    const row = await readWorkspace(owner);
    if (!row.state) throw new HttpError(404, "Projeto não encontrado.");
    const result = mutate(row.state);
    if (await commitWorkspace(owner,row.state,row.revision)) return {result,state:row.state,revision:row.revision+1};
  }
  throw new HttpError(409, "Há outras pessoas comentando neste momento. Tente enviar novamente.");
}
