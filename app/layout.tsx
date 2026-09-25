import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Decor } from "./Decor";
import { WarIntro } from "./WarIntro";
import { THEME_BOOT_SCRIPT } from "./theme";

export const metadata: Metadata = {
  title: "ChainWatch — EPIC Mafia",
  description: "Chain saver duty tracker for EPIC Mafia [40959]",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f4f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // the boot script below stamps a class onto <html> before React hydrates,
    // so the server markup is expected to differ here and only here
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets the theme class before the first paint, so a member on light
            mode never sees the dark layout flash past. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        {children}
        <Decor />
        <WarIntro />
      </body>
    </html>
  );
}
