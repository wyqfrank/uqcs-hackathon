import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FITTED — Live Fashion Battle",
  description: "Face off. Fit check. Find out who fits best.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
