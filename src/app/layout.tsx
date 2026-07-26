import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dispatch Board",
  description: "Cold-calling CRM",
};

// Root layout only. The admin console and the caller app each supply their
// own chrome via route groups, so callers never see admin navigation.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
