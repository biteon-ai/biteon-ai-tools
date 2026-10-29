"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ToastProvider } from "./Toast";

const links = [
  ["/", "Dashboard"],
  ["/agents", "Agents"],
  ["/workflows", "Workflows"],
  ["/models", "Models"],
  ["/rules", "Rules"],
  ["/notifications", "Notifications"],
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const frame = pathname === "/login" ? (
    <main className="min-h-screen">{children}</main>
  ) : (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <aside className="border-b border-slate-800 bg-slate-950 p-4 md:border-b-0 md:border-r">
        <p className="mb-4 text-sm font-semibold tracking-wide text-sky-300">Agent Platform</p>
        <nav className="flex gap-2 overflow-auto md:block md:space-y-1">
          {links.map(([href, label]) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link key={href} href={href} className={`block rounded-lg px-3 py-2 text-sm transition ${active ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-900 hover:text-white"}`}>
                {label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="min-w-0 p-4 md:p-8">{children}</main>
    </div>
  );
  return <ToastProvider>{frame}</ToastProvider>;
}
