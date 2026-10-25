---
name: refactor-plan
description: Suggests a small behavior-preserving cleanup of the selected file. Use when you want Qwen to plan a refactor.
---

# Refactor plan

Review only the code you are given. Stay on this machine.

Suggest a cleanup that keeps the current behavior:

- Duplicated logic that can become one function
- Names that hide what a value is
- Deep nesting that can become a guard clause
- Dead code and unused values visible in the file
- A long function that has a clear seam

Do not change what the program does. Do not invent a new architecture. Skip style nits that do not make the file easier to change. If the file is already clear, say so.

Use this report:

# Refactor plan: <path>

## Summary
<one or two sentences>

## Changes
| Effort | Location | Change | Behavior stays |
| --- | --- | --- | --- |
| Small | file:line | ... | yes |

## Result
<change count, or "No refactor needed.">

Effort is Small, Medium, or Large. Omit the table when there are none.
