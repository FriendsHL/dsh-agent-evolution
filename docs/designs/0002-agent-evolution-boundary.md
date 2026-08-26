# Agent Evolution Boundary

## Decision

Rename the public repository, npm package, and installable bundle to `dsh-agent-evolution`. The name identifies the long-term purpose: provide controlled primitives for composing, evaluating, and improving DSH Agents.

The first runtime plugin is named `agent-experiment-runner`. It exposes three model tools:

- `agent_experiment_list_presets`: list the DSH Agent presets authorized for experiments;
- `agent_experiment_run`: run one standalone task in a fresh child Agent composed from an explicit preset;
- `agent_experiment_compare`: run the same task against baseline and candidate presets and return both evidence records without selecting a winner.

The repository's Design → Design Review → Developer SubAgent → Code Review → QA sequence is a contribution policy only. It is documented in `AGENTS.md` and `CONTRIBUTING.md`; it is not a runtime state machine, model tool, role persona, or system-prompt contribution.

## Runtime purpose

The runtime provides an experiment primitive for a parent Agent or later evolution controller:

1. discover an allowlisted preset;
2. create a fresh child Agent with its own DSH session;
3. mount the selected preset before the child starts;
4. run one complete task;
5. return the selected preset, child session id, stop reason, duration, and final assistant content;
6. optionally repeat the same task for a baseline and candidate composition.

The selected preset determines the child's model-visible tools, prompts, skills, compaction, and other Agent-plane plugins. Host services continue to own model routing, sandbox and approval policy, persistence, and the Agent registry.

This plugin uses `ctx.agents.create()` plus `ctx.agentPresets.mount()` because the current standard `ctx.subagents.start()` request cannot select a preset. The created session records `parentSession`, `delegationDepth`, and `agentPreset`, but it does not set `origin: subagent`: the child is an isolated experiment Agent, not a standard SubAgent provider instance, and therefore must not enter SubAgent lifecycle, descriptor, catalog, continuation, or control surfaces.

## Evolution layers

The installable bundle may grow to contain multiple independently permissioned runtime plugins:

| Layer | Responsibility | First release |
| --- | --- | --- |
| Experiment Runner | Compose a preset, run a task, produce baseline/candidate evidence | Implemented |
| Evaluator | Apply a fixed rubric, executable checks, or human labels | Deferred |
| Attributor | Map a failure to a prompt, skill, tool, policy, or workflow | Deferred |
| Author | Create a candidate preset or plugin revision | Deferred |
| Promoter | Advance or roll back an approved candidate | Deferred |

The first release must not describe deferred layers as implemented. It performs no automatic scoring, mutation, promotion, publication, or self-evolution loop.

## Tool contracts

All preset ids come from `ctx.agentPresets`. By default, the tools expose only presets discovered with `trust: system`. A deployment may set `allowedPresets` to an explicit, non-empty list; each named id must resolve at plugin load, and a `user` preset is usable only through this explicit opt-in. Model calls cannot supply package names, filesystem paths, plugin arrays, Cordis rows, or role prompts.

Child Agents inherit the parent's route unless the tool call supplies a provider and model override. They inherit explicit sandbox state and receive delegated approval policy.

Changing a preset can change model-visible tools, skills, prompts, and other plugin capabilities. The inherited sandbox override and delegated `approval: never` are not relaxed by preset selection, but the deployment remains responsible for authorizing every selected preset and the capabilities it composes.

After a child run reaches quiescence, the plugin calls `ctx.sessions.flush(child.session)` before disposing the handle. A rejected flush is an infrastructure failure and rejects the tool call after disposal. A `false` return means no durability listener was installed: the run result remains valid but reports `persisted: false`, and callers must not treat its session id as durable. A `true` return reports `persisted: true`; at tool return, the DSH persistence provider has acknowledged the complete child log. DSH session logs are the transcript authority; the plugin creates no second transcript store.

`agent_experiment_compare` resolves and authorizes both presets before starting either child, then executes baseline followed by candidate. A normal baseline result starts the candidate even when its stop reason is not `completed`; an infrastructure exception rejects the comparison without starting the candidate. Cancellation before or between runs prevents the next child from starting, and cancellation during a run reaches that child. The result is an evidence pair, not a score. Duration is diagnostic metadata and never a quality verdict.

## Repository development policy

Every non-trivial repository change requires:

1. a decision-complete design and mapped test plan;
2. an independent Design Reviewer verdict;
3. implementation by a Developer SubAgent;
4. independent specification and code-quality review;
5. independent QA execution with fresh command evidence.

This policy governs how contributors change the repository. Runtime users do not see or execute this sequence unless a separate future plugin explicitly implements such a product.

## Test plan

### Unit

- configuration rejects empty tool names, duplicate names, invalid depth/token limits, and invalid allowlists;
- request validation rejects empty tasks and invalid model overrides;
- child stop reasons map to the stable result vocabulary;
- renderers retain preset and child session evidence without discarding structured content;
- a disallowed, unknown, or broken preset fails before child execution;
- the default roster excludes `user` presets while explicit authorization admits only its listed ids;
- flush success, absent durability listeners, flush rejection, cancellation, and child failure all dispose every created handle;
- comparison preflights both presets, preserves baseline/candidate identity, continues after a non-completed baseline, stops after infrastructure failure or cancellation, and does not emit a winner;
- experiment children keep lineage without `origin: subagent` or a SubAgent descriptor.

### Installed package against current DSH

Build the current DSH checkout, create the real npm tarball, and install it through `dsh plugin` into isolated profiles. A deterministic LLM adapter must invoke all three public tools. Assert that:

- Headless starts through the real DSH entrypoint;
- `agent_experiment_list_presets` exposes the installed `minimal` system preset;
- `agent_experiment_run` creates a child session with the requested preset and returns its evidence;
- `agent_experiment_compare` creates distinct baseline and candidate child sessions and returns both records without a winner;
- parent and child JSONL logs preserve tool calls, child lineage, selected preset, assistant outputs, and immediately readable persistence after each tool returns;
- experiment children are absent from the SubAgent catalog and produce no corrupt SubAgent diagnostic;
- the packaged plugin also installs into the Web profile and the built application returns HTTP 200.

The deterministic adapter proves package installation, Loader activation, tool dispatch, preset mounting, Agent execution, and persistence. An optional real-provider smoke may test provider behavior but does not replace the keyless installed-package lane.

## Acceptance criteria

- Public names identify Agent evolution and the implemented experiment-runner role.
- No runtime code or model-visible text enforces the repository contribution workflow.
- All three experiment tools work through a packaged install against current DSH.
- Security and persistence claims match current DSH behavior.
- English and Chinese documentation distinguish implemented primitives from deferred evolution layers.
- Independent Code Review and QA pass before publishing the correction.
