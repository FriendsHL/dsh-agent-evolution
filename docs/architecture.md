# Architecture

## Objective

Agent Factory turns a user task into an explicitly composed DSH Agent run and preserves enough evidence to compare a new composition with a known baseline. It uses Agent presets as versionable compositions and DSH sessions as durable run records.

## Runtime flow

```text
Parent Agent tool call
        |
        v
Agent Factory validates preset and depth
        |
        v
ctx.agents.create(unpublished child)
        |
        +-- persist lineage, depth, and selected preset
        +-- inherit delegated sandbox and approval policy
        +-- mount the selected Agent preset
        |
        v
submit one standalone task -> wait for idle -> read final output
        |
        v
dispose live handle; keep the durable DSH session record
```

The selected preset changes the child's model-facing tools, prompts, skills, compaction, and other preset-owned plugins. It does not replace host services or widen the parent's delegated authority.

## Experiment model

`agent_compare` runs the same task twice:

1. baseline preset;
2. candidate preset.

The result contains both session ids, terminal reasons, durations, and final assistant outputs. This is an evidence pair, not an evaluation. A task-specific evaluator needs a rubric and should be a separate capability.

Keeping evaluation separate avoids a circular claim where the Agent that proposed a candidate also decides, without an external criterion, that the candidate is better.

## Evolution layers

The intended system is split into independently permissioned layers:

| Layer | Responsibility | Current status |
| --- | --- | --- |
| Runner | Compose a preset and execute a task | Implemented |
| Experiment | Produce baseline/candidate evidence pairs | Implemented |
| Evaluator | Apply fixed rubrics, tests, or human labels | Planned |
| Attributor | Map failures to a prompt, skill, tool, policy, or workflow change | Planned |
| Author | Create a new candidate preset or plugin revision | Planned |
| Promoter | Advance an approved candidate or roll it back | Planned |

The Runner should remain small even as later layers grow. It is the execution primitive that evaluators and evolution controllers call, not the owner of every evolution policy.

## Security properties

- A tool call selects only discovered preset ids, optionally restricted by `allowedPresets`.
- The plugin never accepts an arbitrary package name, filesystem path, or Cordis row from the model.
- Delegation depth is monotonic and capped.
- Explicit sandbox state is inherited and delegated approvals are not widened.
- Candidate editing and promotion are not part of the runtime tools.
- Session ids make each result traceable to DSH's durable event log.

## Known limitations

- Comparison runs are sequential and can see external state changes between executions.
- Duration is diagnostic metadata, not a quality score.
- An Agent preset is selected by id; this version does not attach a source commit or content digest to the result.
- The keyless integration lane uses a deterministic LLM provider. A separate real-provider smoke remains useful for provider-specific behavior, but is not required to prove the Agent Factory lifecycle.
