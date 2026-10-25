---
name: test-gaps
description: Points out behavior in the selected file that has no test. Use to find missing tests with the selected Qwen model.
---

# Test gaps

Review only the code you are given. Stay on this machine.

Name the behaviors that should have a test and do not, based on the file itself:

- Branches, error paths, and boundary values
- Failed calls to other functions or services
- Empty input and the one-item case
- State that should stay unchanged when an operation fails

Do not invent a framework the file does not use. If the file shows the test style, follow it. Suggest the case in one sentence. Do not write a full exploit or a long test file.

Use this report:

# Test gaps: <path>

## Summary
<one or two sentences>

## Missing tests
| Priority | Behavior | Suggested case |
| --- | --- | --- |
| High | ... | ... |

## Result
<count, or "No obvious gaps.">

Priority is High, Medium, or Low. Omit the table when there are none.
