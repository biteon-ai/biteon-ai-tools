---
name: bug-review
description: Finds logic bugs, broken edge cases, and missing error handling in the selected file. Use for a bug review with the selected Qwen model.
---

# Bug review

Review only the code you are given. Stay on this machine.

Look for bugs a developer would fix:

- Wrong conditions, off-by-one errors, and swapped branches
- Null, undefined, or empty values that are used unsafely
- Errors that are swallowed or that leave state half-updated
- Async work that is not awaited, raced, or cleaned up
- Values parsed, converted, or compared with the wrong type

Report only bugs visible in the code. Do not invent issues. Do not provide exploit payloads.

Use this report:

# Bug review: <path>

## Summary
<one or two sentences>

## Findings
| Severity | Location | Bug | Fix |
| --- | --- | --- | --- |
| High | file:line | ... | ... |

## Result
<findings count, or "No findings.">

Severity is High, Medium, or Low. Omit the findings table when there are none.
