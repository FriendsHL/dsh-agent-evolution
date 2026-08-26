# dsh-agent-evolution

[English](README.md)

`dsh-agent-evolution` 是一个公开的 DeepSeek Harness bundle，用于受控的 Agent 组合实验。首个运行时插件 `agent-experiment-runner` 会按指定 DSH preset 组装全新的 Agent，在这些 Agent 中运行同一项独立任务，并返回供后续评估使用的证据。

这个 bundle 提供基础能力，不是完整的自动进化循环。它不会自动评分、选择胜者、修改 preset 或 plugin、提升候选版本，也不会发布变更。

## 运行时工具

- `agent_experiment_list_presets` 列出部署方授权的 preset。
- `agent_experiment_run` 用一个 preset 运行一次任务。
- `agent_experiment_compare` 用 baseline 和 candidate preset 依次运行同一任务，返回两份记录，但不判断胜负。

每次运行返回 preset id、子 session id、停止原因、耗时、最终 assistant 内容和 `persisted`。插件先 flush 子 session 日志，再释放 Agent handle。`persisted: true` 表示 DSH 持久化 listener 已在工具返回前确认完整日志；`persisted: false` 表示运行已完成，但当前没有持久化 listener，调用方不能把该 session id 当作持久化引用。

实验子 Agent 是带 lineage 的普通 Agent。其 session header 记录 `parentSession`、`delegationDepth` 和 `agentPreset`，但不记录 `origin: subagent`，因此不会进入 SubAgent catalog、continuation 或 control API。插件采用这条路径，是因为当前标准 SubAgent request 不能选择 Agent preset。

## 安装

DSH 仍处于开发预览阶段。从 GitHub 安装时应固定到已评审的 commit：

```sh
dsh plugin --profile web add github:FriendsHL/dsh-agent-evolution#<commit>
```

包中提供以下 profile patch：

```yaml
- insert:
    - id: agent-experiment-runner
      name: dsh-agent-evolution
      config:
        maxDepth: 3
```

本地开发安装：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-agent-evolution
```

添加或修改 bundle 后，需要重启正在运行的 DSH 进程，让 Loader 重新组装 profile。

## 配置

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `maxDepth` | `3` | 实验子 Agent 的绝对委托深度上限。 |
| `maxTokens` | 继承 | 工具调用未覆盖时采用的可选正整数输出 token 上限。 |
| `allowedPresets` | system-trust roster | 可选的非空 preset id 白名单；显式条目可以包含 user-trust preset。 |
| `listToolName` | `agent_experiment_list_presets` | 模型可见的 preset 查询工具名。 |
| `runToolName` | `agent_experiment_run` | 模型可见的单次运行工具名。 |
| `compareToolName` | `agent_experiment_compare` | 模型可见的对比工具名。 |

未配置 `allowedPresets` 时，查询和执行仅允许来自 `trust: system` root 的 preset。配置显式白名单时，插件加载阶段会解析每个 id；未知或损坏的条目会阻止插件启动。每次执行前还会再次解析目标 preset，因此运行期间被删除或损坏的 preset 会在创建 Agent 之前失败。

选择不同 preset 会改变子 Agent 的模型可见工具、skill、prompt、上下文压缩和其他 Agent-plane plugin。子 Agent 默认继承父 Agent 的模型路由；调用方也可以同时提供 `provider` 和 `model`。子 Agent 继承父 session 的显式 sandbox override；当 approval 能力存在时，委托策略固定为 `approval: never`。Preset 白名单不能替代部署方对各 preset 所加载能力的安全审核。

三个工具名必须非空且互不相同。`allowedPresets` 不能是空数组，也不能包含空 id 或重复 id。`maxDepth`、`maxTokens` 和调用参数 `max_tokens` 会在配置或请求校验阶段拒绝非法值。

## 运行与对比语义

两个执行工具都要求非空且可独立理解的 `task`。`provider` 和 `model` 覆盖值必须同时提供。稳定停止原因包括 `completed`、`max-tokens`、`aborted`、`refusal` 和 `error`；非 `completed` 停止原因仍是有效实验记录，并不等同于基础设施异常。

对比工具会在启动任何子 Agent 前解析并授权两个 preset，然后先运行 baseline，再运行 candidate。即使 baseline 以非 `completed` 原因结束，candidate 仍会运行。创建、执行、持久化或清理异常会终止对比，并阻止下一个子 Agent 启动。运行前或两次运行之间发生取消时也不会启动下一个子 Agent；运行期间的取消会转发给当前子 Agent。

DSH session 日志是完整对话记录的唯一依据。这个 bundle 不会创建第二套 transcript 或评估存储。对于 `persisted: true` 的结果，可通过返回的 session id 检查完整 prompt、工具调用、工具结果和输出。

## 进化能力分层

Experiment Runner 是这个 bundle 的第一层。Evaluator、失败归因、候选版本编写以及提升或回滚属于相互独立的后续能力，便于部署方分别授权和验证。

## 开发与验证

仓库贡献遵循 [CONTRIBUTING.md](CONTRIBUTING.md) 中的独立设计、开发、评审和 QA 规范。该规范只约束本仓库的开发过程，不属于运行时插件能力。

```sh
pnpm run check
# Web 启动用例前需先构建一次 DSH checkout。
DSH_CHECKOUT=/absolute/path/to/deepseek-harness pnpm run test:integration
```

无 API key 的集成测试会打包真实 npm artifact，通过 `dsh plugin` 安装，使用确定性 LLM adapter 调用全部三个模型工具，验证 JSONL 日志在工具返回时已可读取、实验 Agent 不进入 SubAgent catalog，并启动构建后的 DSH Web 应用。组件关系和失败语义见 [Architecture](docs/architecture.md)。

## License

MIT
