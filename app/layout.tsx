import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MOG — Live Fashion Battle",
  description: "Face off. Fit check. Find out who mogs.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
