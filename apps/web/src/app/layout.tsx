import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Grid Bot Platform",
  description: "Solo spot grid trading dashboard on Solana."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
