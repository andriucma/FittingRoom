import { Suspense } from "react";
import { RunView } from "@/components/RunView";

export default function RunPage() {
  // RunView reads the route param on the client; with Cache Components that needs a Suspense boundary.
  return (
    <Suspense fallback={<p className="p-6 text-zinc-400">Loading…</p>}>
      <RunView />
    </Suspense>
  );
}
