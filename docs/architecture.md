# Architecture

## Purpose

The bundle contributes `agent-experiment-runner`, a preset-aware execution primitive for a parent Agent or a later evolution controller. DSH remains responsible for Agent creation, preset composition, model routing, sandbox and approval policy, tool dispatch, and session persistence.

```text
Parent Agent
  -> agent_experiment_list_presets
  -> agent_experiment_run(preset, task)
     -> fresh experiment Agent -> flush session -> dispose handle
  -> agent_experiment_compare(baseline, candidate, task)
     -> fresh baseline Agent  -> flush session -> dispose handle
     -> fresh candidate Agent -> flush session -> dispose handle
  <- raw evidence records; no score or winner
```

## Authorization and composition

`AgentPresets` is the preset source. Without `allowedPresets`, the plugin exposes only rows whose discovered trust is `system`. An explicit non-empty allowlist permits exactly its ids, including user-trust rows; every entry must resolve without a discovery-reported broken reason when the plugin loads. Execution resolves the requested row again before Agent creation.

The runner calls `ctx.agents.create()` because `ctx.subagents.start()` cannot select a preset. Creation metadata copies the parent `cwd`, records `parentSession`, increments `delegationDepth`, and records the chosen `agentPreset`. It deliberately omits `origin: subagent` and does not write a `subagent/descriptor`, so SubAgent discovery does not classify an experiment session as corrupt or expose unsupported continuation and control operations.

The unpublished Agent setup first appends delegated policy overrides, then mounts the selected preset, adds the fixed permission-scope context, and denies the three experiment tools inside the child. Preset mounting determines the child's tools, prompts, skills, compaction, and other Agent-plane services. The parent route is inherited unless a request supplies a provider and model together.

## Execution and persistence

The runner follows up with one user message and waits for the Agent to become idle. It derives the stable stop reason and final assistant blocks from the settled session, calls `ctx.sessions.flush(session)`, and disposes the Agent handle. Every acquired handle is disposed after normal completion, child failure, flush rejection, or cancellation.

A successful flush returns `true` when at least one durability listener participated and `false` when none did. Both are successful run records, distinguished by `persisted`; a flush rejection is an infrastructure error and rejects the tool call after cleanup. The plugin stores no copy of the transcript outside DSH's session provider.

The comparison tool validates its request and resolves both preset rows before creating either Agent. Baseline and candidate execute sequentially to avoid conflating concurrent resource effects. A settled baseline record, including any non-completed stop reason, proceeds to the candidate. An infrastructure exception or cancellation before the candidate prevents its creation.

## Result model

One run record contains `sessionId`, `preset`, `stopReason`, `durationMs`, `persisted`, and the untouched final assistant content blocks. Native rendering adds compact session and persistence metadata without removing structured blocks from the canonical result. Duration is diagnostic metadata, not evaluation input.

Comparison returns `{ baseline, candidate }`. It contains no score, rubric, recommendation, or winner. Evaluation, attribution, candidate authoring, and promotion require separate plugins with their own authority and verification.

## Verification model

Unit tests exercise configuration, authorization, request validation, lineage metadata, lifecycle cleanup, flush outcomes, cancellation, comparison preflight, and stable result rendering. The installed-package test packs the npm artifact, installs it into isolated current-DSH Headless and Web profiles, drives all three tools through a deterministic adapter, reads child JSONL during the parent turn to prove flush timing, queries the SubAgent catalog, and inspects the final persisted logs.

The deterministic adapter verifies Loader activation, tool dispatch, preset mounting, Agent execution, persistence, and application startup without a provider key. It does not measure model quality or prove compatibility with every remote provider.
