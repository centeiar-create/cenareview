import { bindings, HttpError, identity, json, sameOrigin, storageInfo } from "./review-store";
import { mutateWorkspace, readWorkspace, type Comment, type Version, type Workspace } from "./workspace";

type Link = {id: string; owner: string; project_id: string; version_id: string | null; created_at: number; expires_at: number; revoked_at: number | null};
type Visitor = {id: string; name: string; email: string; expires_at: number};
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
const hash = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,"0")).join("");
async function body(request: Request): Promise<Record<string,unknown>> {
  if (Number(request.headers.get("content-length")) > 16000) throw new HttpError(413,"O comentário excedeu o limite de dados.");
  const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  if(reader)while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>16000){await reader.cancel();throw new HttpError(413,"O comentário excedeu o limite de dados.");}chunks.push(chunk.value);}
  const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
  const text = new TextDecoder().decode(buffer);
  try { const data = JSON.parse(text); if (!data || typeof data !== "object" || Array.isArray(data)) throw Error(); return data; }
  catch { throw new HttpError(400,"Os dados enviados são inválidos."); }
}
export async function liveLink(token: string): Promise<Link> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(404,"Link de revisão não encontrado.");
  const row = await bindings().db.prepare("SELECT * FROM review_links WHERE token_hash=?").bind(await hash(token)).first<Link>();
  if (!row) throw new HttpError(404,"Link de revisão não encontrado.");
  if (row.revoked_at || row.expires_at <= Date.now()) throw new HttpError(410,"Este link foi encerrado. Peça um novo link a quem compartilhou a revisão.");
  return row;
}
function scopedProject(state: Workspace, link: Link) {
  const p = state.projects.find(p=>p.id===link.project_id);
  if (!p) throw new HttpError(404,"Este projeto não está mais disponível.");
  return p;
}
function scopedVersion(state: Workspace, link: Link, versionId: unknown): Version {
  const p = scopedProject(state,link), v = p.versions.find(v=>v.id===versionId && (!link.version_id || link.version_id===v.id));
  if (!v) throw new HttpError(404,"Este vídeo não faz parte do link de revisão.");
  return v;
}
async function visitor(request: Request, link: Link, required = true) {
  const token = request.headers.get("cookie")?.split(";").map(x=>x.trim()).find(x=>x.startsWith("cena_reviewer="))?.slice(14);
  let result: Visitor | null = null;
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) result = await bindings().db.prepare("SELECT id,name,email,expires_at FROM review_visitors WHERE link_id=? AND token_hash=? AND expires_at>?").bind(link.id,await hash(token),Date.now()).first<Visitor>();
  if (!result && required) throw new HttpError(401,"Informe seu nome e e-mail antes de comentar.");
  return result;
}
async function limit(key: string, maximum: number) {
  const window = Math.floor(Date.now()/60000);
  const row = await bindings().db.prepare(`INSERT INTO review_rate_limits (key,window,count) VALUES(?,?,1)
    ON CONFLICT(key) DO UPDATE SET window=excluded.window,count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END
    WHERE window!=excluded.window OR count<? RETURNING count`).bind(key,window,maximum).first();
  if (!row) throw new HttpError(429,"Muitos envios em pouco tempo. Aguarde um minuto e tente novamente.");
}
export async function adminLinks(request: Request, id?: string) {
  const owner = await identity(request), db = bindings().db;
  if (request.method === "GET" && !id) {
    const rows = await db.prepare("SELECT id,project_id AS projectId,version_id AS versionId,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt FROM review_links WHERE owner=? ORDER BY created_at DESC LIMIT 300").bind(owner).all();
    return json({links:rows.results});
  }
  sameOrigin(request);
  if (request.method === "DELETE" && id) {
    const r = await db.prepare("UPDATE review_links SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND owner=? RETURNING id").bind(Date.now(),id,owner).first();
    if (!r) throw new HttpError(404,"Link não encontrado.");
    return json({revoked:true});
  }
  if (request.method !== "POST" || id) throw new HttpError(405,"Operação não disponível.");
  const data = await body(request), workspace = await readWorkspace(owner);
  if (!workspace.state) throw new HttpError(404,"Crie o projeto antes de compartilhar.");
  const p = workspace.state.projects.find(p=>p.id===data.projectId);
  if (!p) throw new HttpError(404,"Projeto não encontrado.");
  const versionId = typeof data.versionId === "string" ? data.versionId : null;
  if (versionId && !p.versions.some(v=>v.id===versionId)) throw new HttpError(404,"Vídeo não encontrado.");
  if (!p.versions.length) throw new HttpError(400,"Adicione um vídeo antes de compartilhar o projeto.");
  const count = await db.prepare("SELECT count(*) AS n FROM review_links WHERE owner=? AND revoked_at IS NULL AND expires_at>?").bind(owner,Date.now()).first<{n:number}>();
  if ((count?.n||0)>=300) throw new HttpError(400,"Encerre um link antigo antes de criar outro.");
  const days = Number(data.days ?? 30);
  if (!Number.isInteger(days) || days<1 || days>90) throw new HttpError(400,"Escolha um prazo entre 1 e 90 dias.");
  const token = randomToken(), idNew = crypto.randomUUID(), createdAt=Date.now(), expiresAt=createdAt+days*86400000;
  await db.prepare("INSERT INTO review_links(id,owner,token_hash,project_id,version_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?)").bind(idNew,owner,await hash(token),p.id,versionId,createdAt,expiresAt).run();
  return json({id:idNew,url:new URL(`/r/${token}`,request.url).href,expiresAt},201);
}
export async function reviewState(request: Request, token: string) {
  const link = await liveLink(token), row = await readWorkspace(link.owner);
  if (!row.state) throw new HttpError(404,"Projeto não encontrado.");
  const p = scopedProject(row.state,link), me = await visitor(request,link,false);
  const versions = p.versions.filter(v=>!link.version_id || v.id===link.version_id);
  if (link.version_id && !versions.length) throw new HttpError(404,"Este vídeo não está mais disponível.");
  const storage = await storageInfo(link.owner);
  const mediaIds = new Set(versions.map(v=>v.mediaId));
  return json({project:{id:p.id,name:p.name,client:p.client,versions:versions.map(v=>({
    id:v.id,title:v.title,type:v.type,duration:v.duration,mediaId:v.mediaId,approvedAt:v.approvedAt,
    comments:v.comments.map(c=>({id:c.id,text:c.text,time:c.time,end:c.end,mode:c.mode,category:c.category,priority:c.priority,done:c.done,author:c.author,createdAt:c.createdAt,mine:!!me && c.reviewerId===me.id,
      replies:c.replies.map(r=>({id:r.id,author:r.author,text:r.text,createdAt:r.createdAt}))}))
  }))},assets:storage.assets.filter(a=>mediaIds.has(a.id)).map(a=>({id:a.id,status:a.status,expiresAt:a.expiresAt})),
    reviewer:me ? {name:me.name,email:me.email} : null,expiresAt:link.expires_at,scope:link.version_id?"video":"project",revision:row.revision});
}
export async function identifyReviewer(request: Request, token: string) {
  sameOrigin(request); const link = await liveLink(token), data = await body(request);
  const name = typeof data.name === "string" ? data.name.trim() : "", email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  if (name.length<2 || name.length>80 || /[\x00-\x1F]/.test(name) || email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400,"Informe um nome e um e-mail válidos.");
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  await limit(`identity:${link.id}:${await hash(ip)}`,10);
  const existing = await visitor(request,link,false), id=existing?.id || crypto.randomUUID(), session=randomToken(), expiresAt=Math.min(link.expires_at,Date.now()+30*86400000);
  if (existing) await bindings().db.prepare("UPDATE review_visitors SET name=?,email=?,token_hash=?,expires_at=? WHERE id=? AND link_id=?").bind(name,email,await hash(session),expiresAt,id,link.id).run();
  else await bindings().db.prepare("INSERT INTO review_visitors(id,link_id,token_hash,name,email,created_at,expires_at) VALUES(?,?,?,?,?,?,?)").bind(id,link.id,await hash(session),name,email,Date.now(),expiresAt).run();
  const response=json({reviewer:{name,email}},201);
  response.headers.set("Set-Cookie",`cena_reviewer=${session}; Path=/api/review/${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor((expiresAt-Date.now())/1000)}`);
  return response;
}
export async function reviewComment(request: Request, token: string, commentId?: string, reply=false) {
  sameOrigin(request); const link=await liveLink(token), me=(await visitor(request,link))!, data=await body(request);
  await limit(`write:${me.id}`,30); await limit(`link:${link.id}`,300);
  if (!/^[A-Za-z0-9-]{10,100}$/.test(String(data.requestId||""))) throw new HttpError(400,"Identificador de envio inválido.");
  const text=typeof data.text==="string"?data.text.trim():"", mode=data.mode;
  if (request.method!=="DELETE" && (!text || text.length>(reply?2000:4000))) throw new HttpError(400,"Escreva um comentário dentro do limite de caracteres.");
  if (!reply && request.method!=="DELETE" && (!["point","range","general"].includes(String(mode)) || !Number.isFinite(data.time) || Number(data.time)<0 || Number(data.time)>86400 || (mode==="range" && (!Number.isFinite(data.end) || Number(data.end)<=Number(data.time) || Number(data.end)>86400)))) throw new HttpError(400,"Informe um momento ou trecho válido.");
  const change = await mutateWorkspace(link.owner,state=>{
    const v=scopedVersion(state,link,data.versionId), duration=v.duration;
    if (!reply && request.method!=="DELETE" && mode!=="general" && duration && (Number(data.time)>duration || mode==="range" && Number(data.end)>duration)) throw new HttpError(400,"O tempo indicado ultrapassa a duração do vídeo.");
    const c=commentId ? v.comments.find(c=>c.id===commentId) : undefined;
    if (commentId && !c) throw new HttpError(404,"Comentário não encontrado.");
    if (reply && c) {
      if (c.replies.some(r=>r.id===data.requestId && r.reviewerId===me.id)) return {id:data.requestId};
      if (c.replies.some(r=>r.id===data.requestId)) throw new HttpError(409,"Este envio já possui outro identificador. Tente novamente.");
      if (c.replies.length>=100) throw new HttpError(400,"O limite de respostas deste comentário foi atingido.");
      c.replies.push({id:String(data.requestId),author:me.name,authorEmail:me.email,reviewerId:me.id,text,createdAt:new Date().toISOString()});
      v.approvedAt=null; return {id:data.requestId};
    }
    if (c && c.reviewerId!==me.id) throw new HttpError(403,"Você só pode alterar seus próprios comentários.");
    if (request.method==="DELETE") {v.comments=v.comments.filter(c=>c.id!==commentId);v.approvedAt=null;return {removed:true};}
    const fields={text,mode:mode as Comment["mode"],time:mode==="general"?0:Number(data.time),end:mode==="range"?Number(data.end):null,category:["Texto","Imagem","Áudio","Ritmo","Geral"].includes(String(data.category))?String(data.category):"Geral",priority:data.priority==="high"?"high":"normal"};
    if (c) Object.assign(c,fields);
    else if (!v.comments.some(c=>c.id===data.requestId && c.reviewerId===me.id)) {
      if (v.comments.some(c=>c.id===data.requestId)) throw new HttpError(409,"Este envio já possui outro identificador. Tente novamente.");
      if (state.projects.reduce((n,p)=>n+p.versions.reduce((n,v)=>n+v.comments.length,0),0)>=5000) throw new HttpError(400,"O limite de comentários foi atingido.");
      v.comments.push({id:String(data.requestId),...fields,author:me.name,authorEmail:me.email,reviewerId:me.id,assignee:"",done:false,createdAt:new Date().toISOString(),replies:[]});
    }
    v.approvedAt=null; return {id:c?.id||data.requestId};
  },()=>liveLink(token));
  return json({...change.result,revision:change.revision},request.method==="POST"?201:200);
}
export async function authorizeReviewMedia(token: string, id: string) {
  const link=await liveLink(token), row=await readWorkspace(link.owner);
  if (!row.state) throw new HttpError(404,"Projeto não encontrado.");
  const p=scopedProject(row.state,link);
  if (!p.versions.some(v=>v.type==="hosted" && v.mediaId===id && (!link.version_id || v.id===link.version_id))) throw new HttpError(404,"Vídeo não encontrado neste link.");
  return link.owner;
}
