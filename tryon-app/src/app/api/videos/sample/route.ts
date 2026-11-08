import { registerSample } from "@/lib/server/videos";

/** POST: register the repo's sample spin video (IMG_8204.mov) as a video asset. */
export async function POST() {
  try {
    return Response.json(await registerSample(), { status: 201 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}
