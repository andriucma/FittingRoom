import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { SiteNav } from "@/components/SiteNav";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "FittingRoom — Your style, all around.", template: "%s · FittingRoom" },
  description: "Your personal fitting room. Record a turn, find your outfit, and see it on you from every angle.",
  authors: [{ name: "Armin Hatamian" }, { name: "Marcu Andriuca" }],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <a href="#main-content" className="skip-link">Skip to content</a>
        <header className="site-header">
          <Link href="/" className="brand" aria-label="FittingRoom home">FittingRoom<span className="brand-dot">.</span></Link>
          <Suspense fallback={<nav aria-label="Main navigation"><Link href="/" className="nav-link">Start a fitting</Link><Link href="/runs" className="nav-link">My looks</Link></nav>}><SiteNav /></Suspense>
        </header>
        <main id="main-content" className="flex-1">{children}</main>
        <footer className="site-footer"><div className="footer-brand">FittingRoom<span className="brand-dot">.</span></div><p className="creator-credit">Made by <span>Armin Hatamian</span> &amp; <span>Marcu Andriuca</span></p><span className="footer-note">Your style, all around.</span></footer>
      </body>
    </html>
  );
}
