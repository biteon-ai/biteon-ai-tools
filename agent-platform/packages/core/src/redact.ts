const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /ghp_[A-Za-z0-9]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /bot\d+:[A-Za-z0-9_-]+/g,
  /cursor_[A-Za-z0-9]+/g,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
];

export function redact(value: string): string {
  let next = value;
  for (const pattern of PATTERNS) next = next.replace(pattern, "[redacted]");
  next = next.replace(
    /(api[_-]?key|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)([^"'\s&,}]+)/gi,
    "$1$2[redacted]",
  );
  next = next.replace(/x-access-token:[^@\s]+/gi, "x-access-token:[redacted]");
  return next;
}

export function redactGitArgs(args: string[]): string[] {
  return args.map((arg) => {
    const lower = arg.toLowerCase();
    if (lower.includes("authorization") || lower.includes("x-access-token") || lower.includes("token")) {
      return "[redacted]";
    }
    return arg;
  });
}
