import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// `manifest` and `icons.apple` are what make this installable to a phone
// home screen (`public/manifest.json`, `public/icon-*.png`, generated from
// `public/icon.svg` — see the plan's Task 13 notes for how). Deliberately
// no service worker: offline is out of scope for this app, and a
// half-registered one is the kind of thing that causes stale-cache bugs
// nobody can reproduce reliably. Installing to a home screen and opening
// without browser chrome does not need one — only genuine offline support
// would.
export const metadata: Metadata = {
  title: "Recipe Manager",
  description: "A recipe library for two.",
  manifest: "/manifest.json",
  icons: {
    apple: "/apple-touch-icon.png",
  },
  // Emits `mobile-web-app-capable` / `apple-mobile-web-app-title`. Modern
  // Safari reads `display: standalone` straight from the manifest, but this
  // covers the iOS versions that still need the older meta-tag form too —
  // this app is used from a phone, so both are cheap insurance.
  appleWebApp: {
    title: "Recipes",
  },
};

// `themeColor` moved out of `metadata` and into `viewport` in Next 13.2 —
// see node_modules/next/dist/docs/.../generate-metadata.md, which marks the
// old `metadata.themeColor` field deprecated in favor of this export.
export const viewport: Viewport = {
  themeColor: "#b45309",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
