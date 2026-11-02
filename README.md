# AI Studio WAA Proof & Relay Suite

本项目按职责拆分为三个独立文件夹，全部默认运行于本地端口（无需公网暴露；中转端导入的 Cookie 持久化到 `2-relay-client-gateway/cookies/`，签名端内存池保持零落盘）：

```text
.
├── 1-tampermonkey-cookie-grabber/   # 1. 获取 Cookie 的油猴脚本（含 HttpOnly Cookie + User/Tier 识别 + 剪切板导出）
│   ├── aistudio-cookie-grabber.user.js
│   ├── cookie-export.example.json
│   └── README.md
├── 2-relay-client-gateway/          # 2. 中转反代客户端（暴露本地 OpenAI/Gemini API + 实时 SSE 流式 + 调用 GenerateContent）
│   ├── bin/start-relay.js
│   ├── src/relay-server.js
│   ├── src/dashboard.js
│   ├── test/stream-verify.js
│   ├── .env.example
│   ├── cookies.example.json
│   ├── package.json
│   └── README.md
└── 3-waa-proof-server/              # 3. 服务端 !xxx 签名服务（纯 Node VM + 1h 内存池，无任何获取/轮换 Cookie 逻辑）
    └── API.md
```

---

## 完整使用流程

1. **启动中转反代端（`2-relay-client-gateway`，端口 `18802`）**：
   ```bash
   cd 2-relay-client-gateway
   node bin/start-relay.js
   ```
2. **浏览器油猴抓取 Cookie（`1-tampermonkey-cookie-grabber`）**：
   - 将 `1-tampermonkey-cookie-grabber/aistudio-cookie-grabber.user.js` 安装到 Tampermonkey（在油猴设置中将 `Script cookies access` 设为 `All`）。
   - 打开 `https://aistudio.google.com/`，点击右下角 **「📋 复制 WAA Cookie 到剪切板」**（或直接点 **「🚀 推送本地 18802」**）。
   - 在 `http://127.0.0.1:18802/` 面板粘贴导入即可通过 `http://127.0.0.1:18802/v1/chat/completions` 调用 `gemini-4-argon`、`gemini-3.8-flash` 等模型（支持 `stream: true` 实时 SSE 流式输出）。

---

## 关于 Cookie 的正确抓法，以避免失效 401 问题

**强烈建议使用浏览器无痕模式（Incognito / InPrivate）抓取 Cookie：**

1. **开启篡改猴的无痕权限**：
   - 打开浏览器的扩展管理页面（Chrome 为 `chrome://extensions/`，Edge 为 `edge://extensions/`），找到 **Tampermonkey（篡改猴）** → 点击 **「详情」**。
   - 打开 **「在无痕模式下启用（Allow in Incognito）」** 或 **「在 InPrivate 中允许」**。
   - *(如果你使用 F12 抓包法手动提取 Cookie，则不需要管这一步。)*
2. **新建无痕窗口抓取**：
   - 按 `Ctrl + Shift + N` 新建无痕窗口，在无痕窗口内完成 `https://aistudio.google.com/` 登录与 Cookie 抓取。
   - **抓取完成后直接点击无痕窗口右上角的 `×` 关闭窗口（千万不要在网页内点击「退出账号 / Sign out」，点击退出会导致该 Cookie 会话在 Google 侧立即作废）**。

### 多账号抓取的两种正确做法

* **做法一（最推荐）：一个无痕窗口只登录一个账号**
  - 打开一个无痕窗口 → 登录第 1 个账号 → 抓取 Cookie 导入面板 → **直接关闭该无痕窗口**；
  - 再新建一个新的无痕窗口 → 登录第 2 个账号 → 抓取 Cookie → 关闭无痕窗口，以此类推重复抓新账号。
  - 每个账号拥有各自独立的底层会话，互不影响。
* **做法二：在单个无痕窗口里一次性把所有账号全部登录完**
  - **必须先一次性登录完所有要抓的账号**，全部登录完成后，再依次切换右上角账号，抓一个账号切换一个账号；
  - **注意：中途不要退出任何账号，且严禁“登一个、抓一个、再加登下一个”**（每新登录一个账号，Google 都会重置当前窗口的 `SID` 会话，导致前面已抓的旧 `SID` 失效）；全部抓完后直接关闭无痕窗口。

### 为什么不用无痕模式（用日常窗口）抓的 Cookie 会突然失效报 401？

* Google 的短效滚动凭据（`__Secure-1PSIDTS` / `SIDCC`）绑定在当前浏览器的登录会话（`SID`）上。
* 如果你不用无痕模式，而是直接用**平时日常使用的浏览器窗口**抓 Cookie：
  - 一段时间后，当你用日常窗口浏览网页（如 Google 搜索、YouTube、Gmail、AI Studio）时，**日常窗口的浏览器后台也会自动请求 Google 刷新该会话的滚动 Cookie**；
  - 由于反代服务端续期用的也是同一个窗口的会话，两边同时刷新同一个会话会导致之前抓的滚动 Cookie 被顶掉失效，从而报 `401`。
* 而使用**无痕窗口抓完直接关窗口**后，这套无痕会话就只有反代服务端独自持有并定时续期，即使你在日常窗口里正常登录使用同一个谷歌账号，两边也是完全独立的两套会话，`1PSIDTS` 绝不会互相影响。
