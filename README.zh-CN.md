# dsh-agent-factory

[English](README.md)

这是一个公开的 DeepSeek Harness 插件：它按 DSH Agent preset 组装专用子 Agent，并支持可复现的 baseline/candidate 对照实验。

关于 Runner → Evaluator → Author → Promoter 的演进分层，见 [Architecture](docs/architecture.md)。

## 提供的能力

- `agent_presets`：列出当前 DSH 部署可用的 preset。
- `agent_run`：使用明确指定的 preset 创建全新子 Agent，并执行一个完整、独立的任务。
- `agent_compare`：让 baseline preset 和 candidate preset 执行同一个任务，返回两边结果，但不虚构自动胜负结论。

每次运行都有独立的 DSH session。工具结果返回 session id、preset、结束原因、耗时和最终 assistant 内容。DSH session log 是持久化事实来源；本插件不会再维护一份重复的对话库。

## 为什么选择 preset，而不是任意 plugin 数组

preset 是 DSH 原生的单 Agent 组装单元。每个候选方案都有可审查的 `agent.cordis.yml`、稳定的工具和提示注册，以及正常的生命周期清理。Factory 只从已授权 preset 中选择，不接受模型动态生成的包名或插件路径。

Host 仍然负责持久化、模型路由、沙箱策略、审批策略和 Agent registry 等共享服务；worker 只拥有 preset 选定的模型可见组装。

## 安装

DSH 仍处于 developer preview，建议锁定审查过的 commit，不要直接跟随移动分支：

```sh
dsh plugin --profile web add github:FriendsHL/dsh-agent-factory#<commit>
```

随后刷新页面或重启 DSH Web profile。Bundle 会加入以下配置层：

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

本地开发安装：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-agent-factory
```

本包直接提交可运行的 ESM JavaScript，不使用 `prepare`，所以从 Git 安装不需要授权安装期构建脚本。

## 配置

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `maxDepth` | `3` | 允许的绝对委派深度上限；`0` 会禁止 Factory 启动子 Agent。 |
| `runToolName` | `agent_run` | 单次运行工具名。 |
| `compareToolName` | `agent_compare` | 对照实验工具名。 |
| `listToolName` | `agent_presets` | preset 发现工具名。 |
| `allowedPresets` | 全部已发现 preset | 可选白名单；显式空数组会在加载时失败。 |

子 Agent 默认继承父 Agent 的模型路由；工具调用可以覆盖 provider、model 和最大输出 token。子 Agent 会继承父会话显式沙箱模式并使用委派审批策略；切换 preset 不会扩大权限。

## 使用示例

```text
调用 agent_compare：
- baseline_preset: standard
- candidate_preset: my-coding-v2
- task: 审查认证模块中的真实越权缺陷，并引用文件与行号。
```

对照工具只返回证据，不直接评分。后续可以由独立 evaluator 插件使用固定 rubric 评分、归因，并决定是否晋升 candidate。

## 当前边界

`0.1.0` 先验证“组装 + 实验”这个基础能力，暂不负责：

- 自动编辑或生成 candidate preset；
- 自动评分；
- 把 candidate 晋升为默认 preset；
- 定时运行评测集；
- 提供 Web 实验面板。

这些能力适合拆成独立插件或后续层，使运行 Agent、评估、修改组装和晋升分别拥有清晰权限。

## 社区发现

仓库使用 `dsh-plugin` GitHub topic，这是当前 DSH 社区的事实发现约定。社区目录和内置市场可以从该 topic 自动索引，也可以通过 PR 收录。被市场列出不等于安全背书；安装前仍应审查源码并锁定 commit。

## 开发检查

```sh
pnpm run check
# Web 启动用例要求先在 DSH checkout 中执行一次 `pnpm run build`。
DSH_CHECKOUT=/absolute/path/to/deepseek-harness pnpm run test:integration
```

集成测试不需要 API key，并使用当前 DSH 的真实产品入口。测试会先生成真正的 npm tarball，让 DSH 安装可分发产物，而不是链接源码目录。Headless 用例创建隔离的 `DSH_HOME`，通过 `dsh plugin` 安装 headless bundle 和本插件，使用确定性 LLM adapter 启动 DSH，依次调用 `agent_presets` 和 `agent_run(minimal, ...)`，最后读取落盘的父、子 session 日志。Web 用例把 tarball 安装到另一个隔离 profile，在随机端口启动构建后的 DSH Web，并要求应用根页面返回 HTTP 200。两者共同验证打包、bundle 安装、依赖解析、Loader 激活、Headless/Web 启动、工具分发、preset mount、子 Agent 执行和持久化。CI 会构建并验证当前 `deepseek-ai/deepseek-harness` checkout。

## 许可证

MIT
