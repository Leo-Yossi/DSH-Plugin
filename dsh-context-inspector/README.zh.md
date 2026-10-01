---
description: "查看会话实际发送出去的上下文：发送区一个按钮打开窗口，按原样展示发往模型的完整 payload，并提供代码视图与按来源分组的字段视图。"
kind: "package-reference"
---

# @local/dsh-context-inspector

[English](README.md) | 中文

## 概述

发送区（composer）里多一个按钮，点开一个窗口，展示**本会话实际交给模型的 payload** —— 包含所有字段，不只是 `messages` —— 并提供两种视图：

- **代码视图**：把请求对象当作 JSON 树渲染，发出去什么字段就展示什么。
- **字段视图**：把同样的字段拆出来，按产生它的来源分组、标色。

两种视图都支持像 IDE 那样折叠／展开，长内容默认折叠。`system prompt`、`tool`、`hook` 是十三类来源中的三类；以后新增来源只需加一条表项。

Host 半边把会话日志重建为 `contextPayload` 会话投影；浏览器半边把按钮注册进 `conversation.input.right`、把窗口注册进 `shell.overlay`。插件不向任何会话追加事件，也不发起任何模型调用。

## 使用

1. 打开一个会话，至少发送过一条消息。
2. 点击发送工具行里、紧挨发送按钮的 **已发送上下文** 按钮。
3. 在 **字段视图** 与 **代码视图** 之间切换；点任意一行折叠或展开；用 **全部展开** / **全部折叠** / **重置折叠** 批量操作。
4. 在搜索框里输入关键词即可定位并跳转 —— 见[搜索](#搜索)。

## 搜索

搜索框在工具栏下方。输入即同时完成定位与跳转：命中处就地高亮，下方列表列出命中的位置。

- **两种视图都支持。** 字段视图索引「字段一览」的每一行、每条记录行，以及每个记录体的内部；代码视图索引 payload 树，外加它下方渲染的 harness 侧内容树 —— 且只在该区块真正渲染时才索引它，这样命中永远不会指向一个不存在的锚点。
- **是跳转，不只是列出来。** `↑` / `↓`、`Enter` / `Shift+Enter`，或直接点击结果行，都会移动到该命中处并把它滚动到窗口中央。
- **被折叠的节点会自己展开。** 索引遍历的是**数据**而不是 DOM，所以埋在折叠节点里的命中照样能找到；每条命中都带着包含它的折叠 id 链，跳转时通过**和手动点击同一张 `useFolds` 表**把这几个 id 强制置为展开。由于显式 `true` 的优先级高于「全部折叠」模式，即使先全部折叠，跳转依然能把命中展开出来。
- **匹配规则**是不区分大小写的字面子串，刻意不用正则：payload 里满是 `(`、`[`、`\` 和 `*`，半截的模式绝不能抛错。长字符串既可以按带引号的行匹配，也可以按原始正文匹配。
- **Escape** 在搜索框有内容时清空它；内容为空时（或再按一次）关闭窗口。

这套逻辑的纯函数部分 —— `matchText`、`highlightText`、`collectValueHits`、`collectCodeHits`、`collectFieldHits`、`attrEscape` —— 以 `internals` 导出（与 `dsh-web-app` 同一约定），这样离线测试无需 DOM 就能跑索引。命中就是普通记录 `{ id, openIds, path, label, preview, kind, origin? }`；视图这边唯一的契约是：每个渲染出来的节点都要带上与其折叠 id 相等的 `data-ci-id`。

## 读的是什么，来自哪里

`dsh-agent-loop` 的 `buildRequest()` 冻结一个对象并直接交给 `llm.stream()`：

```js
markAgentLoopRequest(Object.freeze({
  ...header.config,           // provider、model、reasoningEffort?、temperature?、maxTokens?、stop?
  messages: boundaryMessages, // session.deriveMessages()
  toolHistory: session.toolHistory(),
  ...header.tools !== void 0 ? { tools: header.tools } : {},
  sessionId: this.session.id,
  signal
}))
```

这个对象的每一部分都能从持久日志还原，而且 loop 包自己的不变式（`dsh-agent-loop/invariant.js`）就断言"实际请求等于日志事件的折叠结果"：

| payload 字段 | 日志来源 | 折叠方式 |
|---|---|---|
| `provider`、`model`、`reasoningEffort`、`temperature`、`maxTokens`、`stop` | `request/header` → `header.config` | 取最新快照（`dsh-session/request-header.js`） |
| `tools` | `request/header` → `header.tools` | 同一快照；空列表按 `canonicalHeader` 规则省略 |
| `messages` | `system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result` | 按 surface 顺序，应用 `surfaceOp` 位置替换，丢弃空内容的 system/developer/assistant 节点（`deriveEventMessage`） |
| `toolHistory` | `request/header` + `developer/message` | 移植 `ToolHistoryProjection`，含序列基线与 declared/available 对齐 |
| `sessionId` | 正在渲染的会话 | 由浏览器填入（它知道会话 id） |
| `signal` | — | 活的 `AbortSignal`，以标记形式展示 |

除 payload 之外，窗口还展示 harness 在其周围记录的内容：

| 来源 | 日志事件 | 是否发给模型 |
|---|---|---|
| 请求信封 | `request/header` | 是 |
| 工具 schema | `request/header.tools` | 是 |
| 系统提示词 | `system/message` | 是，作为 `messages[0]` |
| 用户／注入／助手／developer 消息 | 对应的 surface 事件 | 是 |
| 工具调用 | `assistant/message` 内的 `tool-call` 块，用 `tool/call` 补标题 | 是 |
| 工具结果 | `tool/result` | 是 |
| 路由元数据 | `request/context` | 否 —— 适配器路由事实 |
| Hook | `hook/invoked`、`hook/result` | 否 —— harness 拦截 |
| 生命周期 | `turn/start`、`step/start`、`compaction/*` | 否 —— 边界标记 |

### 两个如实标注的限制（窗口内会写出来）

1. **`GenerateOptions.system` 始终是 `undefined`。** loop 从不设置它；渲染后的提示词以 `role: 'system'` 消息发送。窗口把 `system` 标为缺失字段并说明原因，而不是编造一个值。
2. **这是逻辑 payload，不是线级请求体。** `dsh-llm` 的 `adapterStream()` 在出口仍可能投影它 —— 文件引用转文本、纯文本模型下图像转文本、按 `modelInfo.toolUpdate` 重写工具 schema —— 而压缩／标题子请求带 `purpose`，根本不经过这个折叠。

## 来源分类与扩展方式

Host 在每条记录上发出稳定的 `origin` id；浏览器独占唯一的呈现表 `ORIGINS`（字形、颜色 token、顺序、是否实际发送）。未知 id 会落到中性样式，所以 Host 先发出新来源、浏览器后跟上也不会坏。

新增一个来源：

1. 在 `index.js` 的 `originForSurface()` 或 `applyEvent()` 的新分支里发出它的 id。
2. 在 `client.js` 的 `ORIGINS` 里加一条表项，并补四个 `origin.<id>` 字典键（标签、描述，`en`/`zh` 各一对）。

除此之外不用改别的地方。测试会断言 Host 能发出的每个 origin 和 kind 都有 `en`、`zh` 两份文案。

## 文件

| 文件 | 作用 |
|---|---|
| [`index.js`](index.js) | Host 半边：`contextPayload` 会话投影与其日志折叠 |
| [`client.js`](client.js) | 浏览器半边：模块工厂、发送区按钮、窗口、两种视图、样式与字典 |
| [`cordis.patch.yml`](cordis.patch.yml) | 包层：一行；其"精确裸包名"也正是 `dsh-client-modules` 发现浏览器 bundle 的依据 |
| [`package.json`](package.json) | `dsh.bundle.patch` + `dsh.client`（`platform: web`、`immediately`、按包名排序的 `inject`） |
| [`locale/`](locale) | 插件管理器展示元数据（`meta.title` / `meta.description`） |
| [`test/smoke.mjs`](test/smoke.mjs) | 折叠逻辑与客户端接线的离线检查 |

### 为什么用会话投影

DSH 自带的 `cordis-plugin-development` 技能（`references/practices.md`）写明：由日志派生的每会话状态应放进 `ctx.sessionProjections` 单元；并且"当客户端需要由会话派生的值时，在 Host 投影上声明 `wire.view` —— 值在到达客户端前就已算好；客户端不自己折叠会话事件"。本插件正是这么做的。单元同步折叠已提交事件、对无关事件返回同一 state 引用、并按 state 记忆化 view，这三点共同保证注册表的 `Object.is` 发布闸门不被击穿。

`stateVersion` 为 `1`；一旦 state 字段或折叠语义变化就要提升它，这样过期的持久化 checkpoint 会被丢弃而不是被重新解释。按契约，投影 state 必须是纯 JSON，因为投影缓存会把它 checkpoint 落盘。

注册表传输的是整体值，所以会话每提交一个事件，窗口数据就会重新发布一次。这是官方 `wire.view` 通道的代价，也正因如此，view 只携带一份 payload，并让记录按路径引用它，而不是重复消息正文。

**state 与 view 里的每个值都必须是无损 JSON。** 投影值会作为 Remote 参数随 `SessionSummary` 一起传输，而 `isRemoteJsonValue`（在 `dsh-typert-protocol` 里）**拒绝嵌套的 `undefined`**——`undefined` 不是 JSON，`JSON.stringify` 会把这个键整个吃掉。只要有一个嵌套 `undefined`，Host 就会拒收转发的 `api-session/added` 事件，于是**在插件启用期间，每一次新建会话都会失败**。这不是假设：曾经有个尚未路由的会话产生了 `payload.provider = undefined`，结果**只有没有 `request/header` 的会话会失败**——正好就是新建会话这条路。可选字段要条件展开，不要赋 `undefined`；并且让离线测试里那份镜像的 `isRemoteJsonValue` 守住它：空状态视图是**必测项**，不是边角情况。

### 文件被重写不等于模块被重新加载

替换已安装的包副本，**不会**改变运行中的 Host 实际执行的代码：Loader 导入的是那一行的 `file://` URL，而 Node 的 ES 模块表在进程生命周期内按 URL 缓存，所以再次 import 同一路径拿到的仍是旧实例。因此卸载重装是不够的——必须**重启进程**才能加载新的模块代。

### 为什么 bundle 不 import 任何 Harness 客户端包

同一份实践参考禁止插件 `require('@deepseek-ai/dsh-client-ui-primitives')` 及任何其他 Harness 客户端包：它们会无预告地变化，而一个抛错的组件会让整个 slot 条目变成空白。因此 React 来自浏览器模块表，每个控件都在此手写，所有颜色都取自 `Theme.listTokens` 列出的 token —— `--dsw-alias-bg-overlay`、`--dsw-alias-label-primary`、`--dsw-alias-border-l1`、`--dsw-alias-state-success-primary` 等 —— 并用 `color-mix()` 派生各来源的色调。`dsh.client.inject` 只用于排序包到达顺序，不注入任何代码。

### 为什么是两个 slot 条目加一个模块级 store

`conversation.input.right` 是会话作用域、带 `useProjection`；`shell.overlay` 是根作用域，是文档指定的"整帧浮层"增量座位。按钮是两个条目里唯一能读到投影的那个，于是它把**投影值**——也就是整个线级 view `{ payload, fields, omitted, records, hooks, marks, stats }`——发布到一个小的可观察 store，窗口用 `useSyncExternalStore` 订阅。模型实际收到的 payload 是 `view.payload`，每条记录的 `path` 都是指向该对象的 JSON 指针；窗口永远不会拿 view 本身去解析路径。组件之外不写 DOM，也不向 `document.body` 做 portal（同样是实践参考的要求）。离开会话即关闭窗口。

### 与 DSH 自带 Trajectory 视图的关系

动手前先读了 `dsh-client-ui-trajectory`，它是现存最接近本插件的东西。它的做法是：一个纯消费型客户端插件（`lib/index.js` 是空的 `apply`），把 **event Definition** 注册进 `ctx.uiConversation.events.register(...)` 形成一个 `trajectory` 目标，再把快照构建器注册进 `ctx.uiConversation.views`，最终作为 `conversation.view` 的一个标签页渲染；请求信封靠匹配 `request/header` 得到，提示词则走共享服务 `ctx.uiConversation.inspectSystemPrompt` / `inspectRequestPrompt`。它的 System Prompt / Tools / Options 检查器与本窗口最接近。

复用了：

- 同一套来源判定：会话日志是唯一真相，请求是日志的纯函数。
- 同样把 `request/header` 当作规范信封读取（最新快照胜出），同样用 surface 事件得到消息列表。
- 同样的 slot 注册约定（`ctx.slots.inject` + `ctx.slots.register`，带 id、order、`locale` 命名空间），以及同样拒绝 import Harness 客户端包。

刻意没复用，以及原因：

- **Trajectory 在浏览器侧折叠，本插件在 Host 侧折叠。** 自带的实践参考要求：只要客户端需要由会话派生的值，就在 Host 投影上声明 `wire.view`，客户端不应自己折叠会话事件。Host 侧折叠还避开了客户端窗口的分页限制：投影驱动覆盖完整已提交日志，所以浏览器还没翻页到的消息依然会被计入。
- **Trajectory 是视图标签页，本插件是按钮加整帧窗口。** 需求指定的入口是发送区里的控件，指定的表面是弹窗，而弹窗归 `shell.overlay` 管。若做成 `conversation.view` 标签页，就会与 Chat、Trajectory 争抢正文座位，而不是浮在它们之上。
- **Trajectory 渲染的是活动流水，本插件渲染的是发出去的请求。** 这里会展示 `hook/invoked` 与 `hook/result`，但明确放在 **harness 侧（不发送给模型）** 一节，因为它们从未到达模型。

## 安装

本插件所在的仓库**本身就是 DSH bundle**，所以常规安装只要一个 spec —— 机制见[仓库根 README](../README.md)。

**在 DSH Desktop 界面里：** 侧边栏 → **Plugins** → **Add plugin**：

```
github:Leo-Yossi/DSH-Plugin
```

（裸的 `owner/repo` 会被输入框的解析器拒绝——它会被当成 npm 包名。请带 `github:` 前缀，或用 `https://github.com/Leo-Yossi/DSH-Plugin`。）

**用 `plugin_manager` 工具**（同一个 spec）：

```
install_bundle(target: "github:Leo-Yossi/DSH-Plugin")
```

**在本目录下、用于开发：**

```powershell
# target 传包目录的绝对路径
install_bundle(target: "<本仓库路径>\dsh-context-inspector")
```

`install_bundle` 会在 profile 里执行 `pnpm add <spec>`、把 bundle 追加进 `dsh.profile.bundles` 并应用。不要手改 profile 的 `package.json` 或 `cordis.patch.yml`。

**两种安装只能留一个**：仓库安装与目录安装会产生两行指向同一个包名的 Loader 行，`dsh-client-modules` 会以 *"resolves from multiple active Loader sources"* 拒绝合成。目录安装是链接（link）而非拷贝，改 `index.js` / `client.js` 立即生效 —— 开发时用这个；仓库安装给其他机器和干净环境用。两者都无运行时依赖，除拉取仓库外可离线完成。

## 测试

```powershell
node test/smoke.mjs
```

241 项检查，全部离线：对合成日志跑折叠（含位置替换、空内容 system 丢弃、工具历史序列、无关事件引用闸门、view 记忆化）；线级契约（每条记录的 `path` 都必须在 `view.payload` 内解析成功，且 payload 不得直接位于 view 顶层）；搜索索引（不区分大小写、折叠子树里的命中带着完整祖先链、长字符串锚定在自己的可展开行上、字段视图的记录体命中会展开所属分组与记录行、同一命中不会重复上报）；加上客户端接线，以及"每个 origin 与 kind 都有中英文案"的交叉校验。

## 验证状态

已在运行中的 Desktop profile 上验证：

- `plugin_manager install_bundle` → `application: applied`，无 warning；`list_bundles` 显示该 bundle 已启用、`installed: true`，行 id 为 `context-inspector`。
- Host 行是活的：`Config.listConfigs` 报告 `status: "absent"`，而据 `dsh-tool-cordis` 的投影器，只有当条目的 fiber 存在、未被禁用、且确实没有导出 `Config` schema 时才会给出该状态 —— 即 `apply()` 执行完毕且未抛错。
- 两个浏览器条目都是活的：`Slots.listSubTree` 显示 `conversation.input.right` 里有 `context-inspector-button`，`shell.overlay` 里有 `context-inspector-panel`，均为 `active: true`。
- `node test/smoke.mjs` 241/241 通过。

**未验证**：渲染后的外观。本环境没有浏览器控制能力，因此视觉效果 —— 间距、浅色／深色下的 token 渲染、JSON 树的折叠行为、窗口在发送区上方的落位 —— 尚未被观察到。
