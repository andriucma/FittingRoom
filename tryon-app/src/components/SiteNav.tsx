"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SiteNav() {
  const pathname = usePathname();
  return <nav aria-label="Main navigation">
    <Link href="/" className="nav-link" aria-current={pathname === "/" || pathname === "/new" ? "page" : undefined}>Start a fitting</Link>
    <Link href="/runs" className="nav-link" aria-current={pathname.startsWith("/runs") ? "page" : undefined}>My looks</Link>
  </nav>;
}
