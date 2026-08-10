import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import SiteHeader from "@/components/SiteHeader";
import { DialogProvider } from "@/components/Dialog";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TyHire",
  description: "Resume screening + interview integrity, by Tychons Solution Pvt Ltd",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      {/* suppressHydrationWarning here (not elsewhere in the tree) because browser
          extensions — password managers, Grammarly, AI assistants like Monica — commonly
          inject attributes onto <html>/<body> before React hydrates, which is not a bug in
          this app and isn't fixable from our side. Scoped to just these two tags so real
          hydration mismatches anywhere else in the app still surface normally. */}
      <body className="min-h-full flex flex-col bg-white" suppressHydrationWarning>
        <DialogProvider>
          <SiteHeader />
          <main className="flex-1 flex flex-col">{children}</main>
        </DialogProvider>
      </body>
    </html>
  );
}
