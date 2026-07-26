import Nav from "@/components/Nav";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Nav />
      <main style={{ padding: "20px 24px" }}>{children}</main>
    </>
  );
}
