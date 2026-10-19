import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DEFAULT_MODEL_DISPLAY_NAME } from "@jarvis/contracts";

import "./globals.css";

export const metadata: Metadata = {
  title: "Jarvis",
  description:
    `Jarvis: scenario-driven ${DEFAULT_MODEL_DISPLAY_NAME} computer-use workflows.`,
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
