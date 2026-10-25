---
name: explain-code
description: Explains what the selected file does, in plain language. Use when you want Qwen to walk through the code.
---

# Explain code

Explain only the code you are given. Stay on this machine.

Write for a developer who has not opened the file before.

Cover:

- What the file is for
- The main path from start to finish
- Important functions or branches, with their location
- Data that comes in and what goes out
- Anything surprising, such as a side effect or a hidden dependency

Do not invent files, functions, or behavior that are not in the code. Do not review security unless the code itself makes the risk obvious. Keep the explanation shorter than the file.

Use this shape:

# Explain: <path>

## Purpose
<one short paragraph>

## Walkthrough
<short sections with file locations>

## Inputs and outputs
<what enters and what leaves>

## Watch outs
<surprises, or "None.">
