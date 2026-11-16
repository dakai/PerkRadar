import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PerkRadar · 多来源优惠线索聚合",
  description: "每两小时聚合六个公开来源的优惠线索，失败来源会标明并在下一轮重试。这是线索聚合，不是逐条认证的领取平台。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f7f8fa",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-dvh bg-[#f7f8fa] font-sans text-[#292d34] antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
