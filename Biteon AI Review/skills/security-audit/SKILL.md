---
name: security-audit
description: >-
  Audits source for OWASP Top 10 issues, SQL injection, XSS, insecure
  deserialization, input validation, and memory safety with the local
  Qwen2.5-Coder-32B model on this VPS. Use when the user asks for a security
  audit, vulnerability review, code review, or a refactor that must stay on
  the local Ollama endpoint and must not send code to an external service.
---

# Security audit

Review and refactor requests stay on the local Ollama server. Do not send source, diffs, or reports to any other model or API.

## Local model

- Model: `qwen:security-audit`
- The website sends the review to the Ollama service in this stack.
- API key: `ollama` (Ollama does not check it)

## What to check

- OWASP Top 10: broken access control, cryptographic failures, injection, insecure design, security misconfiguration, vulnerable components, authentication failures, integrity failures, logging failures, SSRF
- SQL injection
- Cross-site scripting
- Insecure deserialization
- Missing or weak input validation
- Memory safety: bounds, use-after-free, integer overflow, unsafe buffer handling where the language allows it

Report only issues grounded in the code. Do not invent exploits or provide weaponized payloads.

## Scan a file

Run the bundled script. It reads the file locally and posts it only to Ollama:

```bash
python3 ~/.cursor/skills/security-audit/scripts/audit.py path/to/file
```

Use the script's markdown as the report. If the user names several files, run it once per file.

## Review or refactor without the script

1. Read the changed code locally.
2. Apply the checklist above.
3. For a refactor, keep the behavior the same and fix confirmed issues.
4. Reply with the report template below. Do not paste the full source back unless the user asked for the patched code.

## Report template

```markdown
# Security audit: <path>

## Summary
<one or two sentences>

## Findings
| Severity | Location | Issue | Fix |
| --- | --- | --- | --- |
| High | file:line | ... | ... |

## Result
No findings.
```

Severity is Critical, High, Medium, or Low. Omit the findings table when there are none.
