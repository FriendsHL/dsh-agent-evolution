# Reviewed Development Orchestrator

## Decision

Rename the public package and bundle from `dsh-agent-factory` to `dsh-reviewed-development-orchestrator`. The name states the product behavior: it coordinates a software-development run with mandatory design review, code review, and QA stages, performed by isolated DSH SubAgents.

Rename the runtime plugin to `reviewed-development-orchestrator`. Replace the direct child-Agent runner and the broad `agent_run` and `agent_compare` model interface with one `run_reviewed_development` tool. The tool executes a fixed development process through DSH's registered `spawn` SubAgent provider; it does not expose arbitrary child creation, preset selection, or plugin paths.

## Goal

Given one complete software-development task, run these phases in order:

1. a Designer writes the implementation design and test plan;
2. a Design Reviewer returns a structured verdict;
3. an Implementer changes the workspace according to the approved design;
4. a Code Reviewer checks specification compliance and code quality;
5. a QA Agent executes the approved test plan and reports command evidence.

Every role runs in a fresh SubAgent session. The compact parent tool result records the phase, role, child session id, verdict, and summary. Each child session is the authority for that role's complete evidence.

## Non-goals

- The first release defines no dedicated commit, push, publish, merge, or promotion operation. Every role persona prohibits these actions; Design Review blocks a plan containing them, Code Review blocks an implementation reporting them, and QA blocks rather than executes a matching test command. These are behavioral gates: a permitted inherited shell can still perform anything the deployment sandbox, credentials, and network policy allow.
- It does not let a model supply package names, plugin paths, Cordis rows, presets, or role prompts.
- It does not automatically modify Agent presets or plugins in response to a score.
- It does not resume a partially completed run after process restart.
- It does not claim that a persona or tool restriction is a security sandbox.
- It does not automatically revise work after a failed review.

## Composition and authority

One installable bundle contributes one runtime orchestrator plugin and relies specifically on DSH's in-process spawn SubAgent provider. Every role uses `ctx.subagents.start()` and receives a fixed persona, output schema, and tool restriction. Spawned roles inherit the initiating Agent's selected preset composition, model route, workspace, sandbox policy, and delegated approval policy. The bundle defines no role preset ids, does not copy preset loading, and does not modify deployment preset roots.

| Role | SubAgent composition | Tool policy | Required structured output |
| --- | --- | --- | --- |
| Designer | inherited preset + fixed persona | configured discovery tools | Design and test plan |
| Design Reviewer | inherited preset + fixed persona | configured review tools | `PASS`, `CHANGES_REQUIRED`, or `BLOCKED`, with findings |
| Implementer | inherited preset + fixed persona | inherited tools | Implementation summary and tests run |
| Code Reviewer | inherited preset + fixed persona | configured review tools | `PASS`, `CHANGES_REQUIRED`, or `BLOCKED`, with findings |
| QA | inherited preset + fixed persona | configured QA tools | `PASS`, `FAIL`, or `BLOCKED`, plus commands and exit codes |

Tool restrictions remove visible global tools from a role but cannot add tools absent from the initiating preset and do not remove preset-scoped tools. A permitted shell can write even when mutation-specific file tools are hidden; tool filtering is not a filesystem security boundary. Every role inherits the parent's DSH sandbox policy, which the plugin never widens. Every persona prohibits commit, push, publish, merge, and promotion. The Design Reviewer must return `BLOCKED` when the design or test plan includes one of those operations. The Code Reviewer must return `BLOCKED` when the implementation report indicates one occurred. QA must not execute a test command that includes or performs one of those operations and must return `BLOCKED`. Designer, Reviewer, and QA instructions also prohibit production-file changes. These are behavioral restrictions unless the deployment supplies a stronger sandbox, credential, and network policy.

The `providerName` configuration defaults to `spawn` and identifies the deployment's registration of `@deepseek-ai/dsh-subagent-spawn-in-process`; it is not a transport-pluggability promise. The plugin validates provider presence and its persona, structured-output, tool-filter, and depth-limit capabilities before starting the first phase. Every returned run must expose `localAgent`; absence is a deployment error and stops the run. Unknown tool names may still fail when a child starts because the effective tool catalog is scoped to the initiating preset. Remote, fork, ACP, Codex, Claude Code, and third-party providers are outside the first release even if they declare the four start capabilities.

## State machine

```text
planning
  -> design_review
    -> implementation
      -> code_review
        -> qa
          -> completed
```

`CHANGES_REQUIRED`, `FAIL`, `BLOCKED`, cancellation, missing structured output, or a child error stops the first release at the current phase. A failed review is never treated as approval. The orchestrator owns phase order; the initiating model cannot skip a phase, substitute a role, or mark the run complete.

## Tool interface

`run_reviewed_development` accepts:

- `task`: a non-empty, standalone development request;
- optional `provider` and `model`, which must be non-empty and supplied together;
- optional positive `max_tokens` applied symmetrically to every role.

When no model override is supplied, every role inherits the parent route.

It returns:

- `status`: `completed`, `changes_required`, `failed`, `blocked`, `cancelled`, or `error`;
- `stoppedPhase` when the run did not complete;
- ordered phase results containing role, child session id, stop reason, duration, validated structured result, and compact summary.

The parent tool result and its durable log entry contain the task, final status, ordered roles and phases, child session ids, verdicts, and compact summaries. Each child session persists that role's complete prompt, assistant output, tool calls/results, provider descriptor, lineage, and preset selection. The renderer tells the model to inspect those session ids for complete evidence. The executor's in-memory canonical value is not described as durable parent-session data.

## Phase artifacts

Every phase requests a DSH `outputSchema`. A completed child that does not return schema-valid structured data stops the run as an error; prose-only claims never open a phase transition.

The Designer returns:

- `design`: decision-complete implementation design;
- `testPlan`: ordered cases with stable `id`, objective, exact command, and expected result;
- `risks`: concrete risks and mitigations.

The Design Reviewer and Code Reviewer each return:

- `verdict`: `PASS`, `CHANGES_REQUIRED`, or `BLOCKED`;
- `summary`;
- `findings`: severity, subject, and required correction.

The Implementer receives only the original task and approved Designer artifact. It returns:

- `summary`;
- `changedFiles`;
- `testsRun`: commands and observed exit codes, which are informative and do not replace QA.

The QA Agent receives the original task, approved design and test plan, implementation artifact, and passing code-review artifact. It returns:

- `verdict`: `PASS`, `FAIL`, or `BLOCKED`;
- `summary`;
- `checks`: test-plan case id, exact command, observed exit code, and concise evidence;
- `findings`.

Before accepting QA `PASS`, the orchestrator verifies that every required test-plan case has one reported check, every reported exit code is zero, and the QA run's `localAgent.session.events` contain a corresponding shell tool call and successful tool result for the same command. This inspection happens after `run.result` settles and before `run.dispose()`. Missing or contradictory execution evidence changes the run to `error`; it never reports `completed`.

The Designer's test plan must be non-empty, with non-empty ids, objectives, commands, and expected results, and unique ids. Each QA check consumes a distinct foreground shell call/result pair. Calls with `run_in_background: true` do not prove test completion and are rejected. The first release recognizes only `bash` and `pwsh` shell result conventions.

A structured verdict is a protocol field, not proof that the findings are correct. Independent sessions, fixed personas, tool restrictions, and persisted transcripts provide separation and traceability; maintainers still judge consequential changes.

## Lifecycle and failure handling

Each successful `ctx.subagents.start()` transfers one run handle to the orchestrator. It requires a local Agent, awaits `run.result`, performs any phase-specific session inspection, and always calls `await run.dispose()` in `finally`. Start rejection creates no owned handle. Child stop reasons, result rejection, missing local Agent, disposal failure, and parent abort remain distinct diagnostics and map to explicit terminal status without opening the next phase.

The parent abort signal is passed to the active SubAgent. No new phase starts after abort. If disposal also fails, the primary run error remains visible and the cleanup error is included as a secondary diagnostic.

## Repository development policy

Every non-trivial repository change follows the same separation:

1. write a design and mapped test plan before implementation;
2. obtain an independent design-review verdict;
3. assign implementation to a development SubAgent using the approved artifacts;
4. obtain an independent code review covering specification compliance and quality;
5. have a QA Agent run the approved tests and report fresh command evidence;
6. fix findings and repeat the affected review or QA stage before merge.

The implementer cannot approve its own design or code. The QA Agent does not change production files while executing the test plan. The coordinating Agent owns final judgment and may reject an unsupported `PASS`.

## Test plan

### Unit tests

- configuration rejects an empty provider/tool name, invalid depth/token limits, and duplicate or empty tool restrictions;
- structured phase validation accepts the declared fields and rejects missing or role-incompatible verdicts;
- the state reducer allows only the declared phase order and stops on every non-pass outcome;
- phase prompts include the original task and only the artifacts required by that role;
- QA evidence validation rejects missing plan cases, command mismatches, non-zero exits, background shell calls, reused call/result pairs, and absent shell tool results;
- cancellation reaches the active child and every owned run is disposed;
- rendered summaries preserve session ids, phase states, verdicts, and evidence pointers.

### Installed-package integration

Pack the npm artifact and install it through the current DSH `dsh plugin` command in an isolated `DSH_HOME`. A deterministic LLM adapter exercises behavior that crosses the package, Loader, SubAgent provider, session persistence, sandbox delegation, and Web boundaries. Pure state-machine permutations remain unit tests because repeating package installation does not add distinct DSH evidence. The parent must join a real test preset before invoking the tool. Assert that:

- the bundle activates and both Headless and Web profiles start;
- five SubAgent sessions run through the configured provider in required order and inherit the initiating preset;
- one representative non-pass Design Review stops the installed process before implementation; unit tests exhaustively cover every Design Review, Code Review, and QA verdict;
- the Implementer performs one observable write inside the isolated test home before Code Review and QA run;
- the parent log persists the compact phase summary and child ids;
- child logs persist complete phase evidence, lineage, provider descriptors, selected preset composition, and delegated sandbox state;
- a completed result contains all five child session ids, while the QA child log contains matching test commands, successful tool results, and zero exits.

### Permission and failure tests

- a tool call cannot supply a preset, plugin path, role prompt, or provider name for an individual phase;
- every role inherits the parent's selected preset and sandbox policy without a plugin-authored widening event;
- the provider capability preflight fails before the first phase when the configured in-process spawn registration is unsuitable, and a run without `localAgent` fails as a deployment error;
- unit tests prove recursion depth, every review/QA verdict, child stop reasons, result rejection, malformed structured output, disposal failure, and abort map to explicit terminal states and release each owned handle;
- the orchestrator exposes no direct commit, push, publish, merge, or promotion operation; deployment sandbox and credential policy remain responsible for enforcing those restrictions on inherited shell tools.

### Optional provider smoke

A separately invoked real-provider test may run a small development task. It validates provider behavior only and does not replace deterministic installed-package checks.

## Acceptance criteria

- Public names consistently identify reviewed software-development orchestration.
- One model tool enforces all five phases through the standard DSH SubAgent capability and records a separate DSH session for each role.
- Design review and code review must pass before implementation and QA respectively.
- QA passes only when its structured report matches recorded successful test tool calls.
- The repository documents and follows the independent Designer/Reviewer/Implementer/QA contribution process.
- Unit tests and current-DSH installed-package tests pass from a clean checkout.

Supporting arbitrary SubAgent providers requires a future DSH capability that guarantees an inspectable local durable session; the four existing start-time capability flags do not provide that guarantee.
