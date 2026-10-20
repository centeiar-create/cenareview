import * as workspace from "./app/api/workspace/route";
import * as upload from "./app/api/media/route";
import * as media from "./app/api/media/[id]/route";
import * as maintenance from "./app/api/maintenance/cleanup/route";
import {bindings,cleanup,failure,HttpError,identity,json} from "./lib/review-store";
import {adminLinks,authorizeReviewMedia,identifyReviewer,reviewComment,reviewState} from "./lib/sharing";
import type {RuntimeEnv} from "./lib/access";

const methods = (request: Request, allowed: string[]) => {
  if (!allowed.includes(request.method)) throw new HttpError(405,"Operação não disponível.");
};
async function page(request: Request, env: RuntimeEnv, name: string) {
  const url = new URL(request.url); url.pathname=`/${name}`; url.search="";
  const result=await env.ASSETS.fetch(new Request(url,{method:request.method === "HEAD" ? "HEAD" : "GET"}));
  return result;
}
async function demo(request: Request, env: RuntimeEnv) {
  // Only the tiny bundled sample is buffered. User videos stream from R2.
  const result=await env.ASSETS.fetch(new Request(new URL("/demo.mp4",request.url)));
  if (!result.ok) return result;
  const bytes=new Uint8Array(await result.arrayBuffer());
  let start=0,end=bytes.length-1,partial=false;
  const range=request.headers.get("range");
  if (range) {
    const m=/^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || !m[1]&&!m[2]) return new Response(null,{status:416,headers:{"Content-Range":`bytes */${bytes.length}`}});
    if (!m[1]) start=Math.max(0,bytes.length-Number(m[2]));
    else {start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}
    if (!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=bytes.length) return new Response(null,{status:416,headers:{"Content-Range":`bytes */${bytes.length}`}});
    partial=true;
  }
  const headers=new Headers({"Content-Type":"video/mp4","Accept-Ranges":"bytes","Content-Length":String(end-start+1)});
  if(partial)headers.set("Content-Range",`bytes ${start}-${end}/${bytes.length}`);
  return new Response(request.method==="HEAD"?null:bytes.slice(start,end+1),{status:partial?206:200,headers});
}
async function route(request: Request, env: RuntimeEnv): Promise<Response> {
  const p=new URL(request.url).pathname;
  if (p === "/") return Response.redirect(new URL("/admin",request.url),302);
  if (p === "/admin" || p === "/admin/") {
    methods(request,["GET","HEAD"]); await identity(request); return page(request,env,"index.html");
  }
  if (p === "/api/admin/workspace") {methods(request,["GET","PUT"]);return request.method==="PUT"?workspace.PUT(request):workspace.GET(request);}
  if (p === "/api/admin/media") {methods(request,["POST"]);return upload.POST(request);}
  const mediaId=p.match(/^\/api\/admin\/media\/([A-Za-z0-9-]+)$/)?.[1];
  if (mediaId) {
    methods(request,["GET","HEAD","DELETE"]); const ctx={params:Promise.resolve({id:mediaId})};
    return request.method==="DELETE"?media.DELETE(request,ctx):request.method==="HEAD"?media.HEAD(request,ctx):media.GET(request,ctx);
  }
  if (p === "/api/admin/cleanup") {methods(request,["GET","POST"]);return request.method==="POST"?maintenance.POST(request):maintenance.GET(request);}
  const shares=p.match(/^\/api\/admin\/links(?:\/([A-Za-z0-9-]+))?$/);
  if (shares) return adminLinks(request,shares[1]);
  const sharedPage=p.match(/^\/r\/([A-Za-z0-9_-]{43})\/?$/);
  if (sharedPage) {methods(request,["GET","HEAD"]);return page(request,env,"review.html");}
  const review=p.match(/^\/api\/review\/([A-Za-z0-9_-]{43})(?:\/(identity|media|comments)(?:\/([A-Za-z0-9-]+))?(?:\/(replies))?)?$/);
  if (review) {
    const [,token,kind,id,replies]=review;
    if (!kind) {methods(request,["GET"]);return reviewState(request,token);}
    if (kind==="identity" && !id) {methods(request,["POST"]);return identifyReviewer(request,token);}
    if (kind==="media" && id && !replies) {methods(request,["GET","HEAD"]);const owner=await authorizeReviewMedia(token,id);return media.serveMedia(request,owner,id,request.method==="HEAD");}
    if (kind==="comments") {
      methods(request,replies?["POST"]:id?["PATCH","DELETE"]:["POST"]);
      return reviewComment(request,token,id,!!replies);
    }
  }
  if (p==="/demo.mp4") {methods(request,["GET","HEAD"]);return demo(request,env);}
  if (["/styles.css","/app.js","/review.js","/poster.png","/favicon.svg"].includes(p)) {methods(request,["GET","HEAD"]);return env.ASSETS.fetch(request);}
  return json({error:"Página não encontrada."},404);
}
export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    let result: Response;
    try { result=await route(request,env); } catch(error) { result=failure(error); }
    const response=new Response(result.body,result);
    response.headers.set("Referrer-Policy","no-referrer");
    response.headers.set("X-Content-Type-Options","nosniff");
    response.headers.set("X-Robots-Tag","noindex, nofollow, noarchive");
    response.headers.set("Cache-Control","private, no-store");
    response.headers.set("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    response.headers.set("Permissions-Policy","camera=(), microphone=(), geolocation=()");
    return response;
  },
  async scheduled() {
    const result=await cleanup(undefined,20), db=bindings().db;
    await db.prepare("INSERT INTO retention_runs(id,ran_at,removed,failed) VALUES(?,?,?,?)").bind(crypto.randomUUID(),Date.now(),result.removed,result.failed).run();
    await db.prepare("DELETE FROM review_visitors WHERE expires_at<=?").bind(Date.now()).run();
    await db.prepare("DELETE FROM review_rate_limits WHERE window<?").bind(Math.floor(Date.now()/60000)-60).run();
    if (result.failed) throw Error("Falha na limpeza de vídeos expirados.");
  }
};
