import "server-only";

type Operation = { controller: AbortController; created: number };
const operations = ((globalThis as unknown as { __videoOperations?: Map<string, Operation> }).__videoOperations ??= new Map());
const valid = (id: string) => /^[a-zA-Z0-9-]{1,80}$/.test(id);

function operation(id: string) {
  // Keep cancellation tombstones so Cancel arriving before POST cannot start work later.
  const now = Date.now();
  for (const [key, entry] of operations) if (now - entry.created > 60 * 60_000) operations.delete(key);
  let entry = operations.get(id);
  if (!entry) { entry = { controller: new AbortController(), created: now }; operations.set(id, entry); }
  return entry;
}

export function videoOperationSignal(req: Request): AbortSignal {
  const id = req.headers.get("x-video-operation");
  return id && valid(id) ? AbortSignal.any([req.signal, operation(id).controller.signal]) : req.signal;
}

export function cancelVideoOperation(id: string): boolean {
  if (!valid(id)) return false;
  operation(id).controller.abort();
  return true;
}
