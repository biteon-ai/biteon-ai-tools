---
name: performance-review
description: Finds slow or wasteful code paths in the selected file. Use for a performance review with the selected Qwen model.
---

# Performance review

Review only the code you are given. Stay on this machine.

Look for concrete cost:

- Work repeated inside loops, including repeated queries or file reads
- Unbounded lists, missing pagination, and large objects kept in memory
- Blocking calls on a request path
- Copies, parses, or sorts of data that is already usable
- Missing early returns on the common path

Report only costs visible in the code. Do not invent benchmarks. Do not suggest a rewrite that changes behavior unless the current behavior is wasteful.

Use this report:

# Performance review: <path>

## Summary
<one or two sentences>

## Findings
| Impact | Location | Cost | Change |
| --- | --- | --- | --- |
| High | file:line | ... | ... |

## Result
<findings count, or "No findings.">

Impact is High, Medium, or Low. Omit the findings table when there are none.
