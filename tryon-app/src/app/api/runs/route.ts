import { connection } from "next/server";
import { config } from "@/lib/server/config";
import { listRuns, startRun } from "@/lib/server/runs";
import type { RunInput } from "@/lib/types";

export async function GET() {
  await connection();
  return Response.json({ runs: await listRuns() });
}

/** POST RunInput: start the pipeline in the background; poll GET /api/runs/:id. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as Partial<RunInput> | null;
  if (!b?.videoId || !b.top || !b.bottom) {
    return Response.json({ error: "videoId, top and bottom are required" }, { status: 400 });
  }
  const input: RunInput = {
    videoId: b.videoId,
    top: Number(b.top),
    bottom: Number(b.bottom),
    background: b.background === "studio" ? "studio" : "original",
    stepDeg: [20, 30, 45, 60].includes(Number(b.stepDeg)) ? Number(b.stepDeg) : 30,
    model: b.model === "gpt-image-2.6-sunburst" ? b.model : config.models.image,
    quality: (["low", "medium", "high"] as const).includes(b.quality as "low") ? b.quality! : "medium",
    omni: {
      enabled: true,
      resolution: (["360p", "720p", "1080p"] as const).includes(b.omni?.resolution as "720p") ? b.omni!.resolution : "720p",
    },
  };
  if (!config.openaiKey) return Response.json({ error: "OPENAI_KEY is not set" }, { status: 500 });
  if (!config.geminiKey) return Response.json({ error: "GEMINI_API_KEY is required for automatic smooth video" }, { status: 500 });
  try {
    return Response.json(await startRun(input), { status: 202 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
