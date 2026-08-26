# Architecture

## Objective

Reviewed Development Orchestrator turns one standalone software-development request into five isolated, auditable DSH SubAgent runs. Phase order and review gates belong to the plugin rather than the initiating model.

## Runtime composition

```text
Parent Agent
  -> run_reviewed_development
     -> spawn Designer             -> structured design + test plan
     -> spawn Design Reviewer      -> PASS gate
     -> spawn Implementer          -> workspace changes
     -> spawn Code Reviewer        -> PASS gate
     -> spawn QA                   -> test report + recorded shell proof
  <- compact phase summary + child session ids
```

The bundle contains one runtime plugin. It consumes DSH's `ctx.subagents` service and requires the registered provider selected by `providerName` to support structured output, depth limiting, tool filtering, and personas. It also requires a fresh provider (`inheritsParentContext === false`) and rejects any returned run without `localAgent`, because QA evidence must be read from the settled local session before disposal.

Every successful `start()` transfers one run handle to the orchestrator. It awaits `run.result`, performs phase-specific checks, and calls `run.dispose()` in `finally`. A startup rejection owns no handle. Disposal failure changes the phase to `error`; when execution also failed, the summary preserves both diagnostics.

## State and artifacts

The only forward path is:

```text
planning -> design_review -> implementation -> code_review -> qa -> completed
```

`CHANGES_REQUIRED`, `FAIL`, `BLOCKED`, cancellation, a non-completed child stop reason, malformed or missing structured output, missing local Agent, bad QA evidence, and cleanup failure stop the current run. Version 0.1 does not automatically revise and retry.

Each phase receives only the original task and artifacts it needs. Reviewers are separate sessions from the work they review. The Implementer cannot approve its own result, and QA receives both the approved plan and passing code-review report.

The tool's in-memory result carries validated phase artifacts. Its renderer persists a compact parent-visible summary with phase state and child ids. Child DSH sessions retain the complete evidence under the ordinary DSH session persistence mechanism.

## QA evidence rule

For every approved test-plan case, a QA `PASS` must report the same stable id, exact command, and exit code `0`. The QA session must also contain:

1. a `tool/call` for `shellToolName` whose parsed `arguments.command` exactly matches the plan;
2. a paired `tool/result` whose `message.source.callId` matches the call;
3. `isError: false` on that result;
4. no non-zero exit, signal-kill, or timeout marker in the rendered result.

The approved test plan must contain at least one case. Case ids and commands are non-empty, ids are unique, and each case consumes a distinct foreground shell call/result pair. A shell call carrying `run_in_background: true` cannot prove a completed test and is rejected. Version 0.1 supports `bash` and `pwsh` evidence formats only.

Claims without recorded execution evidence become `error`, never `completed`. This validates command execution, not semantic test adequacy; design review remains responsible for the test plan itself.

## Authority and security

- Spawned roles inherit the parent's preset composition, workspace, model route unless overridden symmetrically, sandbox policy, and delegated approval policy.
- Fixed personas are behavioral instructions, not a security sandbox.
- Every role persona prohibits commit, push, publish, merge, and promotion. The Design Reviewer is instructed to block plans containing them, the Code Reviewer to block implementation reports indicating them, and QA to avoid executing matching test commands and return `BLOCKED`.
- Tool filters remove global tools from model visibility and dispatch but cannot add absent tools or suppress preset-scoped tools.
- A permitted shell may mutate files even when file-editing tools are hidden.
- The orchestration implementation has no direct publishing operation. The persona rules above are behavioral gates: a child with an inherited shell can still perform operations allowed by the deployment sandbox, credentials, and network policy, so deployments own hard enforcement.
- The orchestration tool is denied in every child to prevent recursive process creation.

## Package verification

Unit tests cover configuration, prompt artifact isolation, phase order, gates, structured-protocol rejection, local-Agent enforcement, QA evidence, cleanup, and provider preflight. Installed-package tests create the npm tarball, install it through current DSH, drive all five real spawn sessions with a deterministic adapter, exercise the real QA shell tool, inspect persisted session logs, cover a rejected design, and retain Headless/Web startup smoke coverage.

The deterministic adapter is not evidence for a real provider's model quality or network protocol. A separately invoked real-provider smoke may complement but cannot replace the keyless installed-package lane.
