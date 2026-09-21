import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reseña directa · Enlaces para NFC",
  description: "Convierte una ficha de Google Maps en un enlace directo para escribir una reseña.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}
