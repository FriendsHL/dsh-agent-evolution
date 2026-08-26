# dsh-reviewed-development-orchestrator

[简体中文](README.zh-CN.md)

A public DeepSeek Harness bundle that enforces a reviewed software-development process through five fresh DSH SubAgent sessions:

```text
Designer -> Design Reviewer -> Implementer -> Code Reviewer -> QA
```

The single model-facing tool is `run_reviewed_development`. Review failures stop the run, and QA cannot report completion merely by claiming tests passed: a QA `PASS` is accepted only when every approved test-plan command has a matching successful shell call and result in the QA child session.

## What the bundle installs

The bundle inserts one runtime plugin, `reviewed-development-orchestrator`. That plugin registers one tool and uses the existing DSH `spawn` SubAgent provider. It does not copy presets, replace the Agent loop, or install a second transcript store. Spawned roles inherit the initiating Agent's preset, model route, workspace, sandbox policy, and delegated approval policy.

Each role receives a fixed persona, structured-output schema, and tool restriction. Each child session remains the durable source for its complete prompt, output, tool evidence, provider descriptor, lineage, and selected preset. The parent receives a compact ordered summary with child session ids.

## Process and gates

1. Designer inspects the repository and returns a decision-complete design, risks, and an exact test plan. Its persona prohibits commit, push, publish, merge, and promotion steps.
2. Design Reviewer returns `PASS`, `CHANGES_REQUIRED`, or `BLOCKED`. It is instructed to return `BLOCKED` when the design or test plan includes a prohibited release operation. Only `PASS` starts implementation.
3. Implementer changes the workspace according to the approved design and reports changed files and checks run. Its persona prohibits commit, push, publish, merge, and promotion.
4. Code Reviewer independently checks specification compliance and code quality. It is instructed to return `BLOCKED` when the implementation report indicates a prohibited release operation. Only `PASS` starts QA.
5. QA executes every other approved test command and returns `PASS`, `FAIL`, or `BLOCKED`. It is instructed not to execute a test command that includes or performs a prohibited release operation and to return `BLOCKED`. A reported `PASS` is cross-checked against recorded shell events before the run becomes `completed`.

The orchestrator implements no dedicated commit, push, publish, merge, or promotion operation. All five fixed personas prohibit those actions; the review and QA personas also define the blocking behavior above. These are behavioral workflow gates rather than a security guarantee: inherited shell tools retain whatever authority the deployment sandbox grants. Deployments that need enforcement must restrict credentials, network access, tools, and filesystem permissions outside this plugin. Version 0.1 does not automatically revise work after a failed gate.

## Install

DSH is in developer preview. Pin a reviewed commit:

```sh
dsh plugin --profile web add github:FriendsHL/dsh-reviewed-development-orchestrator#<commit>
```

The bundle contributes:

```yaml
- insert:
    - id: reviewed-development-orchestrator
      name: dsh-reviewed-development-orchestrator
      config:
        providerName: spawn
        maxDepth: 3
```

For local development:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-reviewed-development-orchestrator
```

## Configuration

| Field | Default | Purpose |
| --- | --- | --- |
| `providerName` | `spawn` | Registered fresh in-process spawn provider. |
| `maxDepth` | `3` | Absolute delegation-depth cap applied to every role. |
| `maxTokens` | inherited | Optional positive token limit applied symmetrically to every role. |
| `shellToolName` | `bash` (`pwsh` on Windows) | Supported shell tool whose persisted calls/results prove QA execution; other names are rejected. |
| `designerTools` | inherited | Optional non-empty allowlist for the Designer. |
| `reviewerTools` | inherited | Optional non-empty allowlist shared by both reviewers. |
| `qaTools` | inherited | Optional non-empty QA allowlist; it must contain `shellToolName`. |

The orchestration tool is always denied inside child roles. Tool filtering controls model visibility and dispatch, not filesystem security; the host sandbox remains authoritative. Unknown configured tools fail when the child starts.

## Tool input and result

`run_reviewed_development` accepts a non-empty standalone `task`. Optional `provider` and `model` overrides must be supplied together. Optional `max_tokens` applies to all five roles.

Terminal statuses are `completed`, `changes_required`, `failed`, `blocked`, `cancelled`, and `error`. Phase records include the role, child session id, stop reason, duration, verdict where applicable, summary, and validated structured result. Inspect the listed child sessions for complete evidence.

## Development policy

Repository changes follow the same separation enforced at runtime: design and mapped test plan, independent design review, implementation by a development SubAgent, independent code review, and QA execution with fresh evidence. See [CONTRIBUTING.md](CONTRIBUTING.md) and the accepted [design](docs/designs/0001-software-development-orchestrator.md).

## Verification

```sh
pnpm run check
# Build the DSH checkout once before the Web startup case.
DSH_CHECKOUT=/absolute/path/to/deepseek-harness pnpm run test:integration
```

The keyless installed-package suite packs the real npm artifact, installs it through `dsh plugin` into isolated Headless and Web profiles, and verifies:

- all five roles run through DSH's real `spawn` provider in order;
- all children inherit the initiating `minimal` preset;
- design rejection stops before implementation;
- QA executes the approved command through the real shell tool and its persisted result is successful;
- the parent keeps the compact tool result and child ids;
- built DSH Web starts and serves HTTP 200.

The deterministic adapter proves bundle loading, orchestration, tools, lifecycle, persistence, and gates without an API key. It does not replace an optional real-provider smoke.

See [Architecture](docs/architecture.md) for the runtime design and limitations.

## License

MIT
