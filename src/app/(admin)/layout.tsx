import Nav from "@/components/Nav";
import { adminPasswordConfigured } from "@/lib/adminAuth";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read on the server: whether the console is behind a passphrase at all
  // decides both the sign-out button and the unprotected warning.
  return (
    <>
      <Nav protectedConsole={adminPasswordConfigured()} />
      <main style={{ padding: "20px 24px" }}>{children}</main>
    </>
  );
}
