import type { ReactNode } from "react";
import { Shell } from "../components/Shell";
import "./globals.css";

export const metadata = { title: "Agent Platform", description: "Self-hosted autonomous development agents" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
