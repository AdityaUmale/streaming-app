import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from "next/link";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Fermion WebRTC Assignment",
  description: "WebRTC Streaming with HLS",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <nav className="bg-gray-800 text-white p-4 border-b border-gray-700">
          <div className="container mx-auto flex gap-4">
            <Link href="/stream" className="hover:text-blue-400">
              Stream
            </Link>
            <Link href="/watch" className="hover:text-blue-400">
              Watch
            </Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}