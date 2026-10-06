import type { Metadata } from "next";
import { Geist } from "next/font/google";

import { cn } from "@/lib/utils";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "jobkit",
  description: "Turns a job post into an honest application kit.",
};

// Dark only: the app uses the portfolio's dark palette with its lime accent.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GB" className={cn("dark font-sans", geist.variable)}>
      <body>{children}</body>
    </html>
  );
}
