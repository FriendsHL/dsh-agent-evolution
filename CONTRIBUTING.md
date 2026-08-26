# Contributing

Non-trivial changes use a five-stage process with independent evidence.

## 1. Design and test plan

Write a decision-complete design before implementation. State scope, interfaces, data flow, failure behavior, security implications, and explicit non-goals. Map every acceptance criterion to an exact test command and expected result.

## 2. Independent design review

A Reviewer who did not author the design checks it against the request and current repository. Implementation starts only after `PASS`. `CHANGES_REQUIRED` must be resolved and reviewed again; `BLOCKED` stops the change.

## 3. Development SubAgent

Give a fresh development SubAgent the original task and approved design. The Implementer changes only approved scope, preserves unrelated work, and reports changed files and commands already run. It cannot approve its own implementation.

## 4. Independent code review

A separate Reviewer checks specification compliance first, then correctness, maintainability, security, and test adequacy. Findings must name the affected subject and required correction. Resolve material findings and repeat code review before QA.

## 5. QA

A QA Agent that did not implement the change executes every command from the approved test plan against the final workspace. It records exact commands, exit codes, and concise evidence. QA does not change production files. Any failed, skipped, mismatched, or unsupported check prevents `PASS`.

The coordinating Agent verifies review independence and fresh QA evidence before declaring the change ready. Human maintainers retain final authority for consequential changes.
