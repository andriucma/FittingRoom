import { Suspense } from "react";
import { NewRun } from "@/components/NewRun";

export default function NewRunPage() {
  return (
    <Suspense fallback={<p className="p-6 text-zinc-400">Loading…</p>}>
      <NewRun />
    </Suspense>
  );
}
