# dsh-agent-factory

[简体中文](README.zh-CN.md)

A public DeepSeek Harness plugin for composing purpose-built child Agents from DSH presets and running reproducible baseline/candidate experiments.

See [Architecture](docs/architecture.md) for the Runner → Evaluator → Author → Promoter evolution model.

## What it adds

- `agent_presets` lists the presets available to the current DSH deployment.
- `agent_run` creates a fresh child Agent from an explicit preset and runs one standalone task.
- `agent_compare` runs one task against a baseline preset and a candidate preset, returning both outputs without inventing an automatic winner.

Each run has its own DSH session. The tool result returns its session id, selected preset, stop reason, duration, and final assistant content. DSH's session log remains the durable record; this plugin does not create a second transcript store.

## Why presets, not arbitrary plugin arrays

A preset is DSH's native unit of per-Agent composition. It gives every candidate a reviewable `agent.cordis.yml`, stable tool and prompt registration, and normal lifecycle cleanup. The factory chooses among authorized presets instead of accepting model-generated package names or plugin paths.

The host still owns shared services such as persistence, model routing, sandbox policy, approval policy, and the Agent registry. A worker owns the model-facing composition selected by its preset.

## Install

DSH is in developer preview. Pin a reviewed commit instead of installing a moving branch:

```sh
dsh plugin --profile web add github:FriendsHL/dsh-agent-factory#<commit>
```

Then refresh or restart the DSH Web profile. The bundle contributes the following profile layer:

```yaml
- insert:
    - id: agent-factory
      name: dsh-agent-factory
      config:
        maxDepth: 3
        runToolName: agent_run
        compareToolName: agent_compare
        listToolName: agent_presets
```

For local development:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-agent-factory
```

This package is plain ESM JavaScript and commits its runtime entry, so Git installation needs no `prepare` script or install-time build authorization.

## Configuration

| Field | Default | Purpose |
| --- | --- | --- |
| `maxDepth` | `3` | Maximum absolute delegation depth. `0` prevents the factory from starting a child. |
| `runToolName` | `agent_run` | Model-facing run tool name. |
| `compareToolName` | `agent_compare` | Model-facing comparison tool name. |
| `listToolName` | `agent_presets` | Model-facing preset discovery tool name. |
| `allowedPresets` | all discovered presets | Optional allowlist. An explicit empty list is rejected at load. |

Child Agents inherit the parent's model route unless the tool call supplies a provider, model, or maximum-token override. They inherit the parent's explicit sandbox mode and receive delegated approval policy; changing the preset does not widen permissions.

## Example

```text
Use agent_compare with:
- baseline_preset: standard
- candidate_preset: my-coding-v2
- task: Review the authentication module for concrete authorization defects. Cite files and lines.
```

The comparison deliberately returns evidence, not a score. A later evaluator plugin can apply a stable rubric, record attribution, and decide whether a candidate should be promoted.

## Current scope

Version `0.1.0` proves the composition and experiment primitive. It does not yet:

- edit or generate candidate presets;
- score outputs automatically;
- promote a candidate to the default preset;
- schedule repeated evaluation suites;
- expose a Web experiment dashboard.

Those belong in separate plugins or later layers so that running an Agent, evaluating it, editing its composition, and promoting it remain independently permissioned operations.

## Community discovery

The repository uses the `dsh-plugin` GitHub topic, which is DSH's current community discovery convention. Community catalogs and in-app marketplaces can index the bundle from that topic or accept a listing PR. A listing is discovery, not a security endorsement; inspect the source and pin the installed commit.

## Development

```sh
pnpm run check
# Run `pnpm run build` once in the DSH checkout before the Web startup case.
DSH_CHECKOUT=/absolute/path/to/deepseek-harness pnpm run test:integration
```

The integration test is keyless and uses current DSH product entry paths. It first creates the real npm tarball, so DSH installs the distributable package rather than a source-directory link. Its headless case creates an isolated `DSH_HOME`, installs the headless bundle and this plugin through `dsh plugin`, starts DSH with a deterministic LLM adapter, calls `agent_presets`, calls `agent_run` with the shipped `minimal` preset, and then reads the persisted parent and child session logs. Its Web case installs the tarball into an isolated Web profile, starts the built DSH server on a random port, and requires the application root to return HTTP 200. Together they prove packaging, bundle installation, dependency resolution, Loader activation, headless and Web startup, tool dispatch, preset mounting, child Agent execution, and persistence. CI builds and checks the plugin against the current `deepseek-ai/deepseek-harness` checkout.

## License

MIT
