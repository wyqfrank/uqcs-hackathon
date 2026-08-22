import type { Metadata } from "next";
import localFont from "next/font/local";
import { VT323 } from "next/font/google";
import "./globals.css";

/* Two voices, per the FITTED Canvas Street sheet: a hand-tagged graffiti face
   for display, and one blocky arcade face for every piece of UI text. */
const graffiti = localFont({
  src: "./fonts/GraffitiXenoa-Regular.otf",
  variable: "--font-display",
  display: "swap",
  fallback: ["Impact", "cursive"],
});

const arcade = VT323({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-arcade",
  display: "swap",
});

export const metadata: Metadata = {
  title: "FITTED — Live Fashion Battle",
  description: "Face off. Fit check. Find out who fits best.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${graffiti.variable} ${arcade.variable}`}>
      <body>{children}</body>
    </html>
  );
}
