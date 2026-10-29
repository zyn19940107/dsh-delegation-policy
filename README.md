# dsh-delegation-policy

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的委派策略插件：把"该搜就搜、该想就想"从提示词里的**建议**，变成运行时**拦得住的规则**。

![演示](docs/demo.gif)

---

## 它解决什么

小模型有两条坏毛病：

1. **该搜的不搜** —— 凭记忆答版本号、发布日期、API 行为，答错了还很有自信。
2. **该想的不想** —— "用队列还是读写分离"、"指数退避还是固定间隔"这种判断题，它直接凭直觉答了。

写在 `AGENTS.md` 里没用 —— 那是建议，模型一忙起来就忘。这个插件把规则写在**执行点**上：模型做错了，插件当场拦。

---

## 三条路线

| 工具 | 干什么 | 子代理拿到的上下文 | 主 agent 拿到的 |
|---|---|---|---|
| `search_web` | 外部事实 | 干净 | 结论 + 出处（网页正文不进主对话） |
| `think_deep` | 判断题 | 继承本对话 | 结构化结论（结论/关键点/假设/风险/验证） |
| `subagent` / `subagent_fork` | 其它自足任务 | 你选 | 子代理的最终文本 |

---

## 三条硬规则

### 1. 主 agent 不能直接上网

直接调 `web_search` / `web_fetch` / `read_page` 会被**拒绝**，并被告知改用 `search_web`。

判断依据是子代理会话头里的 `origin: 'subagent'` —— 所以子代理自己搜是允许的，被拒的只有主对话。

### 2. 每个子代理有检索预算

子代理的 `web_search` / `web_fetch` 调用次数在 `tools/pre-execute` 处计数，超了直接拒绝，并告诉它"用手上已有的材料作答"。

### 3. 判断题必须委派（这条是新的，也是最关键的）

光有提示词不够 —— 模型会自己跳过分类。所以：

- 插件给主 agent 一个工具 **`classify_question`**：它必须**自己**说明这题是不是判断题（推荐、比较、取舍、设计、风险分析）以及为什么。
- 插件在**模型这一轮说完话的那一刻**检查：
  - 没分类 ⇒ **把模型拽回同一轮**，要求先分类，这一轮不许结束；
  - 判成判断题但还没委派 ⇒ 同样拽回，要求先 `think_deep`；
  - 连着拽 2 次还不照做 ⇒ 放行（门是规矩，不是陷阱）。

> 拦在"这一轮说完"而不是"这一轮结束"，是因为一轮结束要么是某个工具结果宣告的，要么是模型自己答完了 —— 只有后者值得拽。
>
> 门只作用于主 agent。子代理有**完全权限**，想用什么工具用什么。

---

## `think_deep` 里面发生了什么

```
think_deep(task, focus?)
│
├─① 第一轮推理 ── fork 子代理（继承本对话全部历史）
│     └─ 同时旁听它的流 ── 收集它写的 reasoning + content
│
├─② 提取关键词 ── spawn 子代理（跑在你指定的模型上）
│     输入 = ① 的 transcript（推理 + 回答）
│     输出 = 关键词（≤ 你设的上限）
│
├─③ 检索 ── spawn 子代理（干净上下文）
│     输出 = 知识（答案 + 出处）
│
├─④ 第二轮推理 ── fork 子代理
│     输入 = 原问题 + ①的结论 + ③的知识
│
├─⑤ 对抗验证 ── spawn 子代理（干净上下文，敌对角色，专找毛病）
│     输出 = confirmed / conflict + 问题清单 + 证据
│
├─⑥ 若冲突 ── 定向检索（只查有争议的点）+ 修正轮
│
└─⑦ 返回主 agent：结论 / 关键点 / 假设 / 风险 / 验证
```

两个要点：

- **② 吃的是孩子自己的话，不是结论摘要**。要核实的说法就写在孩子写的 reasoning 里，所以提取器读的是那份 transcript。
- **知识不外泄**。检索到的语料只走 ③ → ④ 这条线，不出现在 `think_deep` 的返回值里 —— 主 agent 拿到的是**第二轮之后的结论**，不是那份语料。

---

## 安装

```sh
# 从 GitHub 直接装（pnpm 会跑 prepare 脚本自动打包）
dsh plugin add github:zyn19940107/dsh-delegation-policy

# 或从本地
git clone https://github.com/zyn19940107/dsh-delegation-policy
cd dsh-delegation-policy && pnpm install
dsh plugin add /path/to/dsh-delegation-policy
```

插件会注册一个 Loader 行 `delegation-policy`，配置就是普通的 profile 条目。

---

## 配置

### 在设置页改（推荐）

插件页 → Plugins → **Delegation policy**：

| 项 | 说明 |
|---|---|
| **关键词提取器模型** | ② 那个子代理跑在哪个模型上（可以选别的 provider 的模型） |
| **最多提取几个关键词** | ② 最多命名几个检索词 |
| **强制把判断类问题交给委派** | 关掉就没有判断门（默认开） |

设置页的写入落到 `cordis.patch.yml` 里同一个条目 —— 页面和 YAML 是同一份配置的两面。

### 在 YAML 里改

```yaml
- insert:
    - id: delegation-policy
      name: '@zyn19940107/dsh-delegation-policy'
      config:
        searchProvider: spawn          # 搜索子代理
        thinkProvider: fork            # 思考子代理（fork 继承本对话）
        verifyProvider: spawn          # 验证子代理
        keywordAgentProvider: spawn    # 提取器子代理
        keywordModel: deepseek-v4-pro  # 提取器用的模型
        keywordModelProvider: deepseek-official
        keywordMaxCount: 3             # 最多几个关键词
        keywordSearchCalls: 3          # 关键词检索的调用预算
        judgementEnabled: true         # 判断门
        judgementMaxPullbacks: 2       # 最多拽回几次
        watchMaxChars: 8000            # 提取器能读多少孩子的 transcript
```

配置在**调用时**读取，不是插件启动时读 —— 设置页保存完，下一次 `think_deep` 就生效，不用重启。

---

## 开发

```sh
pnpm build        # 打包宿主端 lib/index.js 和浏览器端 lib/client.js
pnpm typecheck    # 两端都查
pnpm specs        # 规格
```

规格在 `verify/`，每个跑在自己的进程里。

---

## License

MIT
