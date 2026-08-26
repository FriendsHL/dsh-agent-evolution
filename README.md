# dsh-agent-evolution

[简体中文](README.zh-CN.md)

`dsh-agent-evolution` is a public DeepSeek Harness bundle for controlled Agent composition experiments. Its first runtime plugin, `agent-experiment-runner`, runs the same standalone task in fresh Agents assembled from explicit DSH presets and returns evidence for later evaluation.

The bundle supplies primitives rather than an autonomous evolution loop. It does not score outputs, select winners, edit presets or plugins, promote candidates, or publish changes.

## Runtime tools

- `agent_experiment_list_presets` lists presets authorized by the deployment.
- `agent_experiment_run` runs one task with one preset.
- `agent_experiment_compare` runs one task sequentially with baseline and candidate presets and returns both records without choosing a winner.

Each run returns the preset id, child session id, stop reason, elapsed time, final assistant content, and `persisted`. The child log is flushed before its Agent handle is disposed. `persisted: true` means a DSH durability listener acknowledged the complete log before the tool returned; `persisted: false` means the run completed but no durability listener was installed, so callers must not treat the session id as durable.

Experiment children are ordinary lineage-bearing Agents. Their session headers record `parentSession`, `delegationDepth`, and `agentPreset`, but not `origin: subagent`, and they do not appear in SubAgent catalog, continuation, or control APIs. The plugin uses this path because the current standard SubAgent request cannot select an Agent preset.

## Install

DSH is in developer preview. Pin a reviewed commit when installing from GitHub:

```sh
dsh plugin --profile web add github:FriendsHL/dsh-agent-evolution#<commit>
```

The package contributes this profile patch:

```yaml
- insert:
    - id: agent-experiment-runner
      name: dsh-agent-evolution
      config:
        maxDepth: 3
```

For local development:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-agent-evolution
```

Restart a running DSH process after adding or changing the bundle so Loader assembles the new profile.

## Configuration

| Field | Default | Purpose |
| --- | --- | --- |
| `maxDepth` | `3` | Absolute delegation-depth limit for experiment children. |
| `maxTokens` | inherited | Optional positive output-token limit when a tool call does not override it. |
| `allowedPresets` | system-trust roster | Optional non-empty preset-id allowlist. Explicit entries may include user-trust presets. |
| `listToolName` | `agent_experiment_list_presets` | Model-visible discovery tool name. |
| `runToolName` | `agent_experiment_run` | Model-visible single-run tool name. |
| `compareToolName` | `agent_experiment_compare` | Model-visible comparison tool name. |

Without `allowedPresets`, discovery and execution admit only presets from roots configured with `trust: system`. With an explicit allowlist, every id is resolved when the plugin loads; unknown or broken entries prevent activation. A requested preset is resolved again before execution so deletion or damage fails before an Agent starts.

Selecting a preset can change the child's model-visible tools, skills, prompts, compaction, and other Agent-plane plugins. The child inherits the parent's model route unless `provider` and `model` are supplied together, inherits the parent's explicit sandbox override, and receives delegated `approval: never` when approval is composed. Preset authorization does not replace deployment review of the capabilities that each preset mounts.

Tool names must be non-empty and distinct. `allowedPresets` cannot be empty, contain blank ids, or contain duplicates. `maxDepth`, `maxTokens`, and per-call `max_tokens` reject invalid values during configuration or request validation.

## Run and comparison behavior

Both execution tools require a non-empty, standalone `task`. A provider override and model override must be supplied together. The stable stop reasons are `completed`, `max-tokens`, `aborted`, `refusal`, and `error`; a non-completed stop reason is still a valid experiment record rather than an infrastructure exception.

Comparison resolves and authorizes both presets before starting either child. It runs the baseline first and then runs the candidate even when the baseline has a non-completed stop reason. A creation, execution, persistence, or cleanup exception stops the comparison and prevents the next child from starting. Cancellation before or between runs also prevents the next child; cancellation during a run is forwarded to that child.

DSH session logs are the transcript authority. This bundle creates no second transcript or evaluation store. Inspect a durable returned session for the complete prompt, tool calls, results, and output.

## Evolution layers

The experiment runner is the first layer of the bundle. Evaluators, failure attribution, candidate authoring, and promotion or rollback are separate, deferred capabilities so deployments can permission and test them independently.

## Development and verification

Repository contributions follow the independent design, implementation, review, and QA policy in [CONTRIBUTING.md](CONTRIBUTING.md). That policy governs changes to this repository and is not part of the runtime plugin.

```sh
pnpm run check
# Build the DSH checkout once before the Web startup case.
DSH_CHECKOUT=/absolute/path/to/deepseek-harness pnpm run test:integration
```

The keyless integration suite packs the real npm artifact, installs it through `dsh plugin`, invokes all three model tools through a deterministic LLM adapter, verifies immediate JSONL persistence and the absence of SubAgent catalog entries, and starts the built DSH Web application. See [Architecture](docs/architecture.md) for the component and failure model.

## License

MIT
