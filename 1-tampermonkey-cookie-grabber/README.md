# 1. Tampermonkey Cookie & User Grabber (`aistudio-cookie-grabber.user.js`)

在浏览器访问 `https://aistudio.google.com/` 时，通过油猴特权接口 `GM_cookie.list` 一键提取包含 `HttpOnly` 在内的 Google 核心鉴权 Cookie、多账号序号（`authUser`）以及订阅等级（`g1Tier`: 默认 `TIER0`，Pro 自动识别为 `TIER1`，Ultra 识别为 `TIER2`），支持一键复制到系统剪切板或直接推送至本地中转客户端（`http://127.0.0.1:18802`）。

---

## 必配设置（重要）

1. **使用原版 Tampermonkey（v4.18+ / v5.x）或 ScriptCat（脚本猫）**
   - 注意：Violentmonkey（暴力猴）未实现 `GM_cookie` 接口，无法读取 `HttpOnly` Cookie。
2. **开启 Tampermonkey 的 `HttpOnly` Cookie 读取权限**：
   - 打开 Tampermonkey 管理面板 → **设置（Settings）**
   - 第一行 **配置模式（Config mode）** 切换为 **高级（Advanced）**
   - 向下滚动至 **安全（Security）** 区域
   - 将 **脚本 Cookie 访问权限（Script cookies access）** 从默认的 `All but HttpOnly` 改为 **`All`（所有）**。
3. **开启 Chrome 扩展「允许用户脚本」与「无痕模式」开关（Chrome 138+ / Edge）**：
   - 打开 `chrome://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo`（Edge 为 `edge://extensions/`）
   - 打开 **允许用户脚本（Allow User Scripts）**
   - 打开 **在无痕模式下启用（Allow in Incognito）** / **在 InPrivate 中允许**。

---

## 关于 Cookie 的正确抓法，以避免失效 401 问题

**强烈建议使用无痕模式（Incognito / InPrivate）抓取：**

1. 先打开篡改猴的管理扩展页面，打开 **「在 InPrivate 中允许 / 在无痕模式下启用」**（若使用抓包法提取则无需此步）。
2. 新建无痕窗口（`Ctrl + Shift + N`），在无痕窗口里面完成 AI Studio 官网登录和 Cookie 抓取即可。
3. **抓完后直接点击无痕窗口右上角 `×` 关闭窗口（千万不要在网页里点「退出账号 / Sign out」）**。

这里有以下两种做法：
* **做法一（推荐）**：一个无痕窗口只登录一个账号，抓一个 Cookie；抓完一个账号之后关闭该无痕窗口，再新建一个新的无痕窗口，重复抓新账号 Cookie。
* **做法二**：**先在单个无痕窗口里一次性把所有账号全部登录完**，然后再抓一个账号切换一个账号；**不要退出账号，且必须一次性登录完所有要抓的号**，全部抓完后直接关闭无痕窗口。

### 为什么不用无痕模式抓的 Cookie 会突然失效？

* 如果你不用无痕模式，而是用平常使用的浏览器窗口抓 Cookie：
  - 在一段时间后，你平常使用的窗口里打开 Google 相关页面时，浏览器后台也会自动刷新该会话的滚动 Cookie（`__Secure-1PSIDTS` / `SIDCC`）；
  - 由于反代服务端用的也是这个窗口的同一套会话，两边同时刷新会导致之前抓的 Cookie 被顶掉失效，从而报 `401`。
* 使用无痕窗口抓完并直接关掉无痕窗口后，该会话仅由反代服务端独自持有续期，即便你日常窗口继续登录使用同一个谷歌账号，两边也是不同的独立会话，不会互相影响。

---

## 使用方式

1. 将 `aistudio-cookie-grabber.user.js` 导入 Tampermonkey。
2. 打开 `https://aistudio.google.com/`。
3. 页面右下角会出现两个悬浮按钮：
   - **「📋 复制 WAA Cookie 到剪切板」**：将包含 20 项白名单 Cookie（含 14 项 `HttpOnly`）及 `authUser`、`g1Tier` 的 JSON 直接写入系统剪切板（示例格式见 `cookie-export.example.json`）。
   - **「🚀 推送本地 18802」**：通过 `GM_xmlhttpRequest` 直接将当前账号推送到本地中转端 `http://127.0.0.1:18802/v1/accounts/add` 内存池中。
