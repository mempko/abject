/**
 * CassetteRecorder -- the per-object seam between HttpClient and the
 * cassette store. HttpClient asks it two questions: "should this request be
 * served from a recording?" (replay) and "should this response be kept?"
 * (record). Objects not registered here pass through untouched, so the
 * seam costs nothing for the rest of the system.
 */
import { CassetteStore, HTTP_CASSETTE_METHOD, type CassetteRequest, redactRequest } from './cassette.js';

export type RecorderMode = 'record' | 'replay' | 'live';
export interface RecorderEntry {
  mode: RecorderMode;
  store: CassetteStore;
  onRecord?: (store: CassetteStore) => void;
  /** Dot-paths masked in recorded response bodies (from the object's method
   *  declarations). Replay fidelity is deliberately sacrificed at these
   *  paths: rawBody is re-serialized post-redaction, because a verbatim raw
   *  body would defeat the point of masking. */
  redactPaths?: string[];
}

const recorders = new Map<string, RecorderEntry>();

export function setRecorder(objectId: string, entry: RecorderEntry): void {
  recorders.set(objectId, entry);
}
export function clearRecorder(objectId: string): void { recorders.delete(objectId); }

/** `rawBody` is the response text verbatim: HttpClient's contract promises
 *  callers a raw string body, so replay must return the same characters the
 *  world sent rather than a re-stringified parse of them. */
export function beforeRequest(objectId: string | undefined, req: CassetteRequest):
  { status: number; rawBody: string; headers: Record<string, string> } | undefined {
  if (!objectId) return undefined;
  const r = recorders.get(objectId);
  if (!r || r.mode !== 'replay') return undefined;
  const hit = r.store.matchRequest(req);
  if (!hit) throw new Error(`replay miss: no cassette for ${req.method} ${req.url}`);
  return { status: hit.response.status, rawBody: hit.rawBody, headers: {} };
}

export function afterResponse(objectId: string | undefined, req: CassetteRequest,
                              res: { status: number; rawBody: string }): void {
  if (!objectId) return;
  const r = recorders.get(objectId);
  if (!r || r.mode !== 'record') return;
  if (res.status < 200 || res.status >= 300) return;
  // Parse HERE, not in HttpClient: the recorder is the only consumer of the
  // parsed shape, and parsing every response in the system to feed a recorder
  // that is almost never attached would tax the entire runtime's HTTP path.
  let body: unknown = res.rawBody;
  try { body = JSON.parse(res.rawBody); } catch { /* not JSON — keep the text */ }
  let rawBody = res.rawBody;
  if (r.redactPaths?.length && body !== null && typeof body === 'object') {
    let touched = false;
    for (const path of r.redactPaths) {
      let node: unknown = body;
      const keys = path.split('.');
      for (const key of keys.slice(0, -1)) {
        node = node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[key] : undefined;
      }
      const leaf = keys[keys.length - 1];
      if (node !== null && typeof node === 'object' && leaf in (node as object)) {
        (node as Record<string, unknown>)[leaf] = 'REDACTED';
        touched = true;
      }
    }
    if (touched) rawBody = JSON.stringify(body);
  }
  r.store.add({
    method: HTTP_CASSETTE_METHOD, args: {},
    request: redactRequest(req),
    response: { status: res.status, body },
    rawBody,
    parsedOutput: body,
    recordedAt: Date.now(),
  });
  r.onRecord?.(r.store);
}
