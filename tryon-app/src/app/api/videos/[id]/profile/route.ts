import { getVideo, setProfile } from "@/lib/server/videos";
import type { Department } from "@/lib/types";

/** PUT { department: mens|womens|all }: override the auto-detected default department. */
export async function PUT(req: Request, ctx: RouteContext<"/api/videos/[id]/profile">) {
  const { id } = await ctx.params;
  const { department } = ((await req.json().catch(() => ({}))) as { department?: Department });
  if (!department || !["mens", "womens", "all"].includes(department)) return Response.json({ error: "department must be mens|womens|all" }, { status: 400 });
  if (!(await getVideo(id))) return Response.json({ error: "video not found" }, { status: 404 });
  return Response.json(await setProfile(id, department));
}
