import { bindings, cleanup, failure, identity, json, sameOrigin } from "../../../../lib/review-store";
// Manual maintenance is owner-only. Native scheduled() runs without an HTTP endpoint.
export async function POST(request: Request) {
  try { await identity(request); sameOrigin(request); const result = await cleanup(), runId = crypto.randomUUID();
    await bindings().db.prepare("INSERT INTO retention_runs (id,ran_at,removed,failed) VALUES(?,?,?,?)").bind(runId, Date.now(), result.removed, result.failed).run();
    return json({ runId, ...result, commentsPreserved: true });
  } catch (error) { return failure(error); }
}
export async function GET(request: Request) {
  try { await identity(request); const latest = await bindings().db.prepare("SELECT id,ran_at AS ranAt,removed,failed FROM retention_runs ORDER BY ran_at DESC LIMIT 1").first(); return json({ latest }); } catch (error) { return failure(error); }
}
