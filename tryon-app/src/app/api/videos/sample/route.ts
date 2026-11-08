import { videoOperationSignal } from "@/lib/server/videoOperations";
import { registerSample } from "@/lib/server/videos";

/** POST: register the repo's sample spin video (IMG_8204.mov) as a video asset. */
export async function POST(req: Request) {
  const signal = videoOperationSignal(req);
  try {
    signal.throwIfAborted();
    return Response.json(await registerSample(signal), { status: 201 });
  } catch (e) {
    if (signal.aborted) return new Response(null, { status: 499 });
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}
