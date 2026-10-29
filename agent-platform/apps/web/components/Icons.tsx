import type { SVGProps } from "react";

export type IconName =
  | "check"
  | "x"
  | "alert"
  | "info"
  | "play"
  | "pause"
  | "logs"
  | "edit"
  | "shield"
  | "key"
  | "boxes"
  | "scan"
  | "test"
  | "book"
  | "layout"
  | "access"
  | "gauge"
  | "database"
  | "workflow"
  | "target"
  | "spark"
  | "settings"
  | "chevron";

const paths: Record<IconName, string> = {
  check: "M5 12.5 9.2 17 19 7",
  x: "M7 7l10 10M17 7 7 17",
  alert: "M12 4.5 3.5 19h17L12 4.5Zm0 5.2v4.6M12 16.8h.01",
  info: "M12 16.5v-4.2M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  play: "M8 6.5v11l10-5.5-10-5.5Z",
  pause: "M8 6.5h2.6v11H8v-11Zm5.4 0H16v11h-2.6v-11Z",
  logs: "M6 7h12M6 12h12M6 17h8",
  edit: "M4 16.5V20h3.5L18.8 8.7 15.3 5.2 4 16.5ZM13.8 6.7l3.5 3.5",
  shield: "M12 3.5 5 6.2v5.2c0 4.2 2.8 7.2 7 8.6 4.2-1.4 7-4.4 7-8.6V6.2L12 3.5Z",
  key: "M14.5 8.5a3.5 3.5 0 1 1-3.2 5H8l-1.5 1.5L5 13.5 6.5 12H11.3a3.5 3.5 0 0 1 3.2-3.5Z",
  boxes: "M4 8.5 12 4.5l8 4v7l-8 4-8-4v-7Zm8-4v15M4 8.5l8 4 8-4",
  scan: "M5 8V5h3M16 5h3v3M19 16v3h-3M8 19H5v-3M8 12h8",
  test: "M9 4h6M10 4v2.2L6.2 16.2A2 2 0 0 0 8 19h8a2 2 0 0 0 1.8-2.8L14 6.2V4",
  book: "M5 5.5A2.5 2.5 0 0 1 7.5 3H19v16H7.5A2.5 2.5 0 0 0 5 21.5V5.5Z",
  layout: "M4 5h16v14H4V5Zm0 4h16M10 9v10",
  access: "M12 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM6.5 18.2a5.5 5.5 0 0 1 11 0",
  gauge: "M5 16a7 7 0 1 1 14 0M12 13l3.2-3.2",
  database: "M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Zm0 0v10c0 1.7 3.1 3 7 3s7-1.3 7-3V7M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  workflow: "M7 7h.01M17 17h.01M8 7h6l-6 10h8",
  target: "M12 12h.01M12 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm0 3.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6Z",
  spark: "M12 3.5 13.6 9 19 10.5 13.6 12 12 17.5 10.4 12 5 10.5 10.4 9 12 3.5Z",
  settings: "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM4.8 12h1.6M17.6 12h1.6M12 4.8v1.6M12 17.6v1.6M6.7 6.7l1.1 1.1M16.2 16.2l1.1 1.1M17.3 6.7l-1.1 1.1M7.8 16.2l-1.1 1.1",
  chevron: "M6 9.5 12 15.5 18 9.5",
};

export function Icon({ name, className = "h-4 w-4", ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden {...props}>
      <path d={paths[name]} />
    </svg>
  );
}
