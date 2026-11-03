import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SimOs Studio",
  description: "Build and run a real Linux-based operating system in your browser.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
