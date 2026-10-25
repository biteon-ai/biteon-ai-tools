#!/usr/bin/env python3
"""Scan one source file with the local Qwen2.5-Coder model."""

import argparse
import json
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:11434/v1"
DEFAULT_MODEL = "qwen:security-audit"
SYSTEM = """You are a local security auditor. The code never leaves this machine.
Review only the file you are given. Check OWASP Top 10, SQL injection, XSS, insecure deserialization, input validation, and memory safety.
Return a markdown report with a Summary, a Findings table (Severity, Location, Issue, Fix), and a Result line.
Use Critical, High, Medium, or Low. If nothing is wrong, say so and omit invented issues.
Do not provide exploit payloads."""


def audit(path, base_url, model):
    source = open(path, encoding="utf-8", errors="replace").read()
    body = json.dumps(
        {
            "model": model,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": SYSTEM},
                {
                    "role": "user",
                    "content": f"File: {path}\n\n```\n{source}\n```",
                },
            ],
        }
    ).encode()
    request = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer ollama",
        },
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        payload = json.load(response)
    return payload["choices"][0]["message"]["content"]


def main():
    parser = argparse.ArgumentParser(description="Local security audit of one source file")
    parser.add_argument("path", help="Source file to scan")
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()
    try:
        print(audit(args.path, args.base_url, args.model))
    except urllib.error.URLError as error:
        sys.exit(f"Local model is not reachable: {error}")
    except (OSError, KeyError, json.JSONDecodeError) as error:
        sys.exit(f"Audit failed: {error}")


if __name__ == "__main__":
    main()
