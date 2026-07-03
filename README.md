# my-email-relay

Cloudflare Email Worker：收到邮件后通过 **Resend 转发到指定邮箱** + 用 Workers AI 生成中文摘要**推送到 Telegram**。

## 功能

- 解析邮件头（主题/发件人/时间，支持 RFC 2047 编码，中文不乱码）
- 解析正文：`text/plain` / `text/html` / 多层嵌套 `multipart`，支持 base64、quoted-printable，按声明 charset 解码
- 用 Workers AI（`env.AI`）生成中文摘要，摘要 + 原文片段推送 Telegram（HTML 格式，自动转义；失败降级纯文本）
- 通过 Resend API 转发到 `FORWARD_EMAIL`；转发内容为中文正文模板，小邮件会附带原始 `.eml`；转发失败会单独发 Telegram 告警

## 配置（wrangler.toml）

| 项 | 说明 |
|---|---|
| `[ai] binding = "AI"` | Workers AI 绑定 |
| `vars.AI_MODEL` | 摘要模型，默认 `@cf/meta/llama-3.1-8b-instruct` |
| `TELEGRAM_TOKEN` | **secret** |
| `CHAT_ID` | **secret**，Telegram chat id |
| `FORWARD_EMAIL` | **secret**，转发目的邮箱；多个地址可用英文逗号分隔 |
| `RESEND_API_KEY` | **secret**，Resend API key |
| `RESEND_FROM` | **secret/var**，Resend 发件人，如 `Mail Relay <relay@example.com>`；可选，不配时默认 `Mail Relay <收到邮件的地址>` |

secret 用 `npx wrangler secret put <名字>` 设置（加密存 Cloudflare，不进仓库，部署时自动保留）。

```bash
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put CHAT_ID
npx wrangler secret put FORWARD_EMAIL
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM
```

`RESEND_FROM` 的域名必须已经在 Resend 验证。若不设置 `RESEND_FROM`，默认使用收到邮件的地址作为发件地址，因此该地址所属域名同样需要在 Resend 验证。

`npx wrangler secret list` 显示配置项

`echo "<value>" | npx wrangler secret put <key>`



## 部署

```bash
npx wrangler login        # 若 env 里有 CLOUDFLARE_API_TOKEN，先 unset 再 login
npx wrangler deploy
```

> ⚠️ 改成 wrangler 部署后，**不要再回 Cloudflare dashboard 在线改 worker.js**，否则下次 `wrangler deploy` 会覆盖。改代码改本地这份再 deploy。

## Email Routing（关键）

“哪个收件地址触发本 Worker”在 **Dashboard → Email → Email Routing → Routing rules** 配置，不在 wrangler.toml 里。

- 规则动作选 **Send to a Worker → my-email-relay** 的地址，才会走本 Worker（发 Telegram + 按本代码转发）。
- 动作是 **Send to an email** 的地址是 Cloudflare **直接转发**，**不经过 Worker**，不会有 Telegram。

排查“邮箱收到但 Telegram 没有”时，先确认该地址的路由动作是不是指向了 Worker。

## 已知行为

- 用 `FORWARD_EMAIL` 同一个 Gmail 账号自发自收时，Gmail 可能去重/折叠，收件箱看不到（去 All Mail 找）。用别的发件邮箱测试即可正常入箱。
- 正文读取上限 256KB（`MAX_RAW_BYTES`），推送正文/摘要上限见 `MAX_BODY` / `AI_INPUT_LIMIT`。
- 原始 `.eml` 附件上限 4MB（`MAX_RESEND_EML_BYTES`）；更大的邮件仍会转发解析出的正文，但不会附带完整原始邮件。
