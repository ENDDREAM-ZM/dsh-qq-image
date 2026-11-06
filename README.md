<div align="center">

# dsh-qq-image

**给 DSH 用的 QQ 生图插件 · 文生图 / 小说封面 / 文生视频，基于 dsh-agnes-studio**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.1-8A2BE2)
![OneBot](https://img.shields.io/badge/OneBot-v11-00A1D6)
![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020-339933)
![生图](https://img.shields.io/badge/%E7%94%9F%E5%9B%BE-%E2%9C%93-FF6F61)
![封面](https://img.shields.io/badge/%E5%B0%81%E9%9D%A2-%E2%9C%93-FFB300)
![视频](https://img.shields.io/badge/%E8%A7%86%E9%A2%91-%E2%9C%93-7E57C2)

</div>

> 群友说「画一只在雨里跑的柯基」→ 出图发群里。写小说的还能说「给《深海余生》做个封面」。

> **前置依赖**：需要先安装 [`dsh-agnes-studio`](https://www.npmjs.com/package/dsh-agnes-studio)；apiKey 通过 [agnes-ai.cn](https://agnes-ai.cn/) 注册获取。

---

在 QQ 里说「画一只在雨里跑的柯基」，机器人调用生图 API 把图发回来。
写小说的话还可以说「给《深海余生》做个封面」，插件会自动拼好封面提示词。

- 文生图 / 文生视频 / 小说封面三种玩法
- 任何 **OpenAI 兼容**的 `/images/generations` 服务都能接
- 出图后直接发到聊天里（图片段），视频发视频段

---

## 前置依赖

**必须先安装 `dsh-agnes-studio`** —— 生图 / 生视频的能力由它提供，本插件只负责把 QQ 消息翻译成调用。

**apiKey 需通过 <https://agnes-ai.cn/> 注册后获取**，装完填到插件设置里（或用环境变量 `AGNES_API_KEY`）。

```bash
npm install -g dsh-agnes-studio
grep dsh-agnes-studio "$DSH_HOME/profiles/"*/package.json   # 确认已登记到 bundles
```

`install.sh` 会检测它，**没装就取消安装并给出提示**。

如果你自己有 OpenAI 兼容的生图服务（提供 `POST /images/generations`、`POST /videos`、`GET /videos/{id}`），可以跳过检查：

```bash
bash install.sh --allow-no-agnes
```

然后在插件设置里填 `apiBaseUrl` 和 `apiKey`（也可用环境变量 `AGNES_API_BASE_URL` / `AGNES_API_KEY`）。


## 指令

| 你说 | 它做什么 |
|---|---|
| `画一只在雨里跑的柯基` | 文生图 |
| `生图 赛博朋克风格的城市夜景` | 文生图 |
| `给《深海余生》做个封面` | 小说封面（自动加书名/作者/风格，竖版 864x1152） |
| `生视频 海浪拍打礁石，慢镜头` | 文生视频（`allowVideo: true` 时） |

触发器：`生图 画图 绘图 生封面 做封面 画封面 生成封面 封面图 生视频 生成视频 图 画 图片 短片 生成`
外加一句兜底：`给/帮/帮我/帮忙/替 X 做|生成|画|来|整 个|张 封面`

群里默认**要 @**（`requireAtInGroup: true`），私聊直接说就行。

---

## 设置

| 字段 | 默认 | 说明 |
|---|---|---|
| `onebotHttpUrl` / `onebotWsUrl` / `onebotToken` / `onebotWsToken` / `selfId` | 见根 README | OneBot 连接 |
| `apiBaseUrl` | `https://api.agnes-ai.cn/v1` | 生图服务地址（任何 OpenAI 兼容服务都行） |
| `apiKey` | `""` | 也可用环境变量 `AGNES_API_KEY` / `QQ_IMAGE_API_KEY` |
| `imageModel` | `agnes-image-2.5-flash` | 文生图模型名，按你的服务商改 |
| `videoModel` | `agnes-video-2.5-flash` | 文生视频模型名 |
| `imageSize` | `1024x1024` | 普通出图尺寸 |
| `coverSize` | `864x1152` | 封面尺寸（竖版，适合网文封面 3:4） |
| `videoSeconds` | `"5"` | 视频时长（**字符串**，别写成数字） |
| `videoSize` | `720P` | 视频分辨率 |
| `promptSuffix` | 见下 | 统一追加的画质后缀 |
| `maxMB` | `40` | 文件体积上限 |
| `videoTimeoutMinutes` | `15` | 视频轮询超时 |
| `maxWaitMinutes` | `0` | 兼容老字段，0 = 用上面那个 |
| `requireAtInGroup` | `true` | 群里要 @ |
| `allowVideo` | `true` | 关掉后只生图 |

默认 `promptSuffix`：`画面清晰，构图讲究，不要文字水印，不要变形的手`

---

## 换服务商

只要对方是 OpenAI 风格就行：

```yaml
apiBaseUrl: https://your-endpoint/v1
apiKey: sk-你的key
imageModel: your-image-model
videoModel: your-video-model
```

请求契约：

- 出图：`POST {apiBaseUrl}/images/generations` → 返回 `data[0].url` 或 `data[0].b64_json`
- 出视频：`POST {apiBaseUrl}/videos` 建任务 → `GET {apiBaseUrl}/videos/{id}` 轮询（`503 video_queue_full` 会重试）

---

## 自测

```bash
node contract-test.mjs
node smoke-test.mjs        # 假 OneBot + 真 API（没配 key 时会跳过真实调用）
```

---

## 已知边界

- 生图是**同步等待**的，慢的服务商会让指令响应变慢（视频是后台任务 + 轮询，不阻塞）；
- 图片走 base64 直发，太大（默认 >40MB 或平台限制）会失败；
- 服务商 401 会原样透传，方便你判断 key 是否过期。

---

<!-- siblings -->
## 相关插件

- [dsh-qq-sing](https://github.com/ENDDREAM-ZM/dsh-qq-sing) · QQ音乐 / 酷狗 / 网易云点歌
- [dsh-qq-voice](https://github.com/ENDDREAM-ZM/dsh-qq-voice) · 9 种方言语音
- [dsh-qq-bundle](https://github.com/ENDDREAM-ZM/dsh-qq-bundle) · 三个一起装

---

## 免责声明

> [!WARNING]
> 本插件通过**非官方接口**访问 QQ，**可能违反腾讯服务条款并导致封号**。请使用**小号**测试。

| 风险 | 说明 |
|---|---|
| 账号 | 可能被限制、封禁或永久封号 |
| 数据 | 封号可能导致好友、群聊、记录不可恢复 |
| 接口 | 上游接口随时变更，功能可能突然失效 |
| 隐私 | 聊天内容会发送给你自行配置的模型服务商 |

**禁止用途**：违法违规、垃圾信息群发、诈骗骚扰、自动化养号、绕过腾讯安全风控、
大规模抓取他人数据、商业代挂代刷、侵犯他人隐私与著作权。

完整条款（含责任限制、合规检查清单、卸载方法）见 **[DISCLAIMER.md](DISCLAIMER.md)**。
