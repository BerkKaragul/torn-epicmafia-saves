import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Decor } from "./Decor";
import { WarIntro } from "./WarIntro";
import { HalloweenDecor } from "./HalloweenDecor";
import { EventProvider } from "./EventContext";
import { THEME_BOOT_SCRIPT } from "./theme";
import { eventEnd, runningEvent } from "@/lib/event";

// every page reads the running event (for the event theme), so none can be
// prerendered at build time
export const dynamic = "force-dynamic";

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

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const event = await runningEvent();
  const halloween = event?.theme === "halloween";
  const active = event
    ? { id: event.id, name: event.name, theme: event.theme, ends_at: eventEnd(event) }
    : null;

  return (
    // the boot script below stamps a class onto <html> before React hydrates,
    // so the server markup is expected to differ here and only here. During an
    // event the server sets the event theme's class itself (see globals.css).
    <html lang="en" className={halloween ? "halloween" : undefined} suppressHydrationWarning>
      <head>
        {/* Sets the theme class before the first paint, so a member on light
            mode never sees the dark layout flash past. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        <EventProvider value={active}>
          {children}
          {halloween && <HalloweenDecor />}
          <Decor />
          {!active && <WarIntro />}
        </EventProvider>
      </body>
    </html>
  );
}
