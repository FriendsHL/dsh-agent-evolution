# dsh-reviewed-development-orchestrator

[English](README.md)

这是一个公开的 DeepSeek Harness bundle，通过五个全新的 DSH SubAgent session 强制执行带独立评审的软件开发流程：

```text
设计 Agent -> 设计评审 Agent -> 开发 Agent -> 代码评审 Agent -> QA Agent
```

它只暴露一个模型工具：`run_reviewed_development`。评审不通过会立即停止；QA 也不能只靠文字声称测试通过。只有当批准的每条测试命令都能在 QA 子 session 中找到匹配且成功的 shell 调用与结果时，QA 的 `PASS` 才会被接受。

## Bundle 安装什么

Bundle 插入一个运行时插件 `reviewed-development-orchestrator`。该插件注册一个工具，并调用 DSH 已有的 `spawn` SubAgent provider。它不复制 preset、不替换 Agent loop，也不建立第二套对话存储。

每个角色都有固定 persona、结构化输出 schema 和工具限制。子 Agent 继承入口 Agent 的 preset、模型路由、工作目录、sandbox policy 和委托后的 approval policy。每个子 session 是完整 prompt、输出、工具证据、provider descriptor、lineage 和 preset 信息的持久化依据；父 Agent 只接收带子 session id 的紧凑阶段摘要。

## 固定流程

1. 设计 Agent 检查仓库，给出可直接实施的设计、风险和精确测试方案；其 persona 禁止把 commit、push、publish、merge 或 promotion 写入实施或测试步骤。
2. 设计评审 Agent 返回 `PASS`、`CHANGES_REQUIRED` 或 `BLOCKED`；当设计或测试方案包含上述发布操作时，其 persona 要求返回 `BLOCKED`。只有 `PASS` 才进入开发。
3. 开发 Agent 按已批准设计修改工作区，并报告变更文件与已运行检查；其 persona 禁止 commit、push、publish、merge 和 promotion。
4. 代码评审 Agent 独立检查需求符合度和代码质量；当实现报告表明执行过上述发布操作时，其 persona 要求返回 `BLOCKED`。只有 `PASS` 才进入 QA。
5. QA Agent 执行其他已批准测试命令，返回 `PASS`、`FAIL` 或 `BLOCKED`；遇到包含或执行上述发布操作的测试命令时，其 persona 要求不要执行并返回 `BLOCKED`。编排器会用 session 中的真实 shell 事件复核 `PASS`。

编排器自身不实现专用的 commit、push、publish、merge 或 preset 提升操作。五个固定 persona 均明确禁止这些行为，评审和 QA persona 还定义了上述阻断行为。但这些是行为层工作流门禁，不是安全保证：继承的 shell 仍具有部署 sandbox 所授予的权限。需要强制隔离时，部署方必须在本插件之外限制凭据、网络、工具和文件系统权限。首个版本不会在评审失败后自动修改重试。

## 安装

DSH 仍处于开发预览阶段，建议固定到已审查的 commit：

```sh
dsh plugin --profile web add github:FriendsHL/dsh-reviewed-development-orchestrator#<commit>
```

Bundle 提供以下配置层：

```yaml
- insert:
    - id: reviewed-development-orchestrator
      name: dsh-reviewed-development-orchestrator
      config:
        providerName: spawn
        maxDepth: 3
```

本地开发：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-reviewed-development-orchestrator
```

## 配置

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `providerName` | `spawn` | 已注册的全新进程内 spawn provider。 |
| `maxDepth` | `3` | 所有角色共用的绝对委托深度上限。 |
| `maxTokens` | 继承 | 可选正整数，统一应用到所有角色。 |
| `shellToolName` | `bash`（Windows 为 `pwsh`） | 用于核验 QA 真实执行记录的受支持 shell 工具名；其他名称会被拒绝。 |
| `designerTools` | 继承 | 设计 Agent 可选的非空工具白名单。 |
| `reviewerTools` | 继承 | 两个 Reviewer 共用的可选非空工具白名单。 |
| `qaTools` | 继承 | QA 可选非空工具白名单，必须包含 `shellToolName`。 |

编排工具在所有子角色中始终不可用。工具过滤只控制模型可见性与调用权限，不是文件系统安全边界；真正的权限仍由宿主 sandbox 决定。配置未知工具时，子 Agent 启动会明确失败。

## 工具输入与结果

`run_reviewed_development` 接收非空、可独立理解的 `task`。可选的 `provider` 与 `model` 必须成对提供；`max_tokens` 会统一应用到五个角色。

终态包括 `completed`、`changes_required`、`failed`、`blocked`、`cancelled` 和 `error`。每个阶段记录角色、子 session id、停止原因、耗时、适用时的 verdict、摘要和已验证结构化结果。完整证据应通过返回的子 session id 查看。

## 开发规范

本仓库自身也执行相同分工：先写设计和对应测试方案，独立设计评审通过后交给开发 SubAgent，实现后进行独立代码评审，最后由 QA Agent 按批准方案提供新鲜测试证据。详见 [CONTRIBUTING.md](CONTRIBUTING.md) 和已通过评审的[设计文档](docs/designs/0001-software-development-orchestrator.md)。

## 验证

```sh
pnpm run check
# Web 启动用例前需先构建一次 DSH checkout。
DSH_CHECKOUT=/absolute/path/to/deepseek-harness pnpm run test:integration
```

无 API key 的安装集成测试会打包真实 npm tarball，通过 `dsh plugin` 安装到隔离的 Headless 与 Web profile，并验证：五个角色按顺序走真实 `spawn` provider；所有子 Agent 继承入口的 `minimal` preset；设计拒绝后不会进入开发；QA 通过真实 shell 工具执行批准命令且持久化结果成功；父 session 保存紧凑结果与子 session id；构建后的 DSH Web 能启动并返回 HTTP 200。

确定性 adapter 验证 bundle 加载、编排、工具、生命周期、持久化和 gate，不代表真实模型 provider 的兼容性；真实 provider smoke 可另行执行。

运行时结构与限制见 [Architecture](docs/architecture.md)。

## License

MIT
