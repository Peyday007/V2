import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "Enrichment Desk",
  description: "Lead enrichment and decision-maker discovery",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main style={{ padding: "20px 24px" }}>{children}</main>
      </body>
    </html>
  );
}
