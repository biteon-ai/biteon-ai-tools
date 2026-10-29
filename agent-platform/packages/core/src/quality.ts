const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "openai-like key", pattern: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: "github token", pattern: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "github fine-grained token", pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export interface QualityReport {
  ok: boolean;
  notes: string[];
  blocking: string[];
}

export function evaluateQualityGates(input: {
  diff: string;
  files: string[];
  skills: Record<string, boolean>;
  validationPassed: boolean;
  validationDetail: string;
  allowEmptyChecks: boolean;
  commandsConfigured: boolean;
}): QualityReport {
  const notes: string[] = [];
  const blocking: string[] = [];
  if (!input.commandsConfigured && !input.allowEmptyChecks) {
    blocking.push("validation commands are not configured");
  } else if (!input.validationPassed) {
    blocking.push(input.validationDetail || "validation commands failed");
  } else if (input.validationDetail) {
    notes.push(input.validationDetail);
  }
  if (input.skills["secrets-scan"]) {
    for (const secret of SECRET_PATTERNS) {
      if (secret.pattern.test(input.diff)) blocking.push(`secrets scan found ${secret.name}`);
    }
  }
  if (input.skills["security-audit"]) {
    if (input.diff.includes("eval(")) notes.push("diff introduces eval");
    if (input.diff.includes("dangerouslySetInnerHTML")) notes.push("diff introduces dangerouslySetInnerHTML");
    if (/child_process/.test(input.diff) && /exec\(/.test(input.diff)) notes.push("diff introduces shell execution");
  }
  if (input.skills["dependency-review"] && input.files.some((file) => file.endsWith("package.json") || file.endsWith("pnpm-lock.yaml") || file.endsWith("requirements.txt"))) {
    notes.push("dependency manifest changed");
  }
  if (input.skills["migration-review"] && input.files.some((file) => file.includes("migration"))) {
    notes.push("database migration changed");
  }
  if (input.skills["cicd-validation"] && input.files.some((file) => file.includes(".github/workflows/") || file.endsWith("Dockerfile") || file.endsWith("docker-compose.yml"))) {
    notes.push("CI or deployment config changed");
  }
  return { ok: blocking.length === 0, notes, blocking };
}
