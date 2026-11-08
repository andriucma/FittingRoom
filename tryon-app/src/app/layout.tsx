import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "FittingRoom — A new look. Every angle.", template: "%s · FittingRoom" },
  description: "Your personal fitting room. Record a turn, find your outfit, and see it on you from every angle.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <a href="#main-content" className="skip-link">Skip to content</a>
        <header className="site-header">
          <Link href="/" className="brand" aria-label="FittingRoom home"><span className="brand-mark"><Icon name="hanger" /></span>FittingRoom<span className="brand-dot">.</span></Link>
          <nav aria-label="Main navigation">
            <Link href="/new" className="nav-link">Fitting room</Link>
            <Link href="/runs" className="nav-link">My looks</Link>
          </nav>
          <Link href="/" className="header-action">New fitting <Icon name="arrow" width="16" height="16" /></Link>
        </header>
        <main id="main-content" className="flex-1">{children}</main>
        <footer className="site-footer"><span>FittingRoom<span className="brand-dot">.</span></span><p>Capture · Style · Preview</p><span className="footer-note">360° fitting workspace</span></footer>
      </body>
    </html>
  );
}
