import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "屏幕截图",
  description: "Tauri screenshot tool"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
