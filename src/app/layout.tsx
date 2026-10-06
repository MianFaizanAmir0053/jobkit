import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";

import { cn } from "@/lib/utils";

import "./globals.css";
import { ServiceWorker } from "./ServiceWorker";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "jobkit",
  description: "Turns a job post into an honest application kit.",
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = { themeColor: "#060607" };

// Dark only: the app uses the portfolio's dark palette with its lime accent.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GB" className={cn("dark font-sans", geist.variable)}>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
