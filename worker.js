export default {
  async email(message, env, ctx) {
    const { TELEGRAM_TOKEN, CHAT_ID, FORWARD_EMAIL } = env;

    const subject = decodeMimeHeader(message.headers.get("subject")) || "无主题";
    const from = decodeMimeHeader(message.headers.get("from")) || "未知发送者";
    const dateStr = message.headers.get("date") || "未知时间";
    const to = message.to;

    // 读取原始邮件（流只能消费一次，必须在 forward 前完成）。
    // 设上限防止大附件邮件撑爆内存 / 超 CPU，超出部分仅用于正文解析时丢弃。
    let body;
    try {
      const rawEmail = await streamToString(message.raw, MAX_RAW_BYTES);
      body = extractBody(rawEmail);
    } catch (e) {
      body = `（正文解析失败：${e.message}）`;
    }

    // 先把原文转发到邮箱（容错：失败单独告警，不让 AI 延迟拖慢转发）。
    if (FORWARD_EMAIL) {
      try {
        await message.forward(FORWARD_EMAIL);
      } catch (e) {
        await notifyTelegram(env, `⚠️ <b>邮件转发失败</b>\n${esc(e.message)}\n主题: ${esc(subject)}`);
      }
    }

    // AI 摘要 + Telegram 通知：直接 await。email handler 里 waitUntil 的后台任务
    // 不保证执行，必须在 handler 生命周期内完成，所以 await 而非 fire-and-forget。
    const summary = await summarizeBody(env, subject, body);
    const text =
      `📬 <b>收到新邮件！</b>\n\n` +
      `👤 发件人: ${esc(from)}\n` +
      `🎯 收件人: <b>${esc(to)}</b>\n` +
      `⏰ 时间: ${esc(dateStr)}\n` +
      `📝 主题: ${esc(subject)}\n\n` +
      summary;
    await notifyTelegram(env, text);
  },
};

const MAX_BODY = 3000;
const MAX_RAW_BYTES = 256 * 1024; // 仅读取前 256KB 用于解析正文
const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct"; // 可换成 env.AI_MODEL 覆盖
const AI_INPUT_LIMIT = 6000;                        // 喂给模型的正文上限（字符）

// ── AI 摘要 ───────────────────────────────────────────────
// 用 Workers AI 生成中文摘要；失败/无绑定时降级为截断原文，绝不影响主流程。
async function summarizeBody(env, subject, body) {
  const cleaned = (body || "").trim();

  // 太短没必要摘要，或没配 AI 绑定 → 直接展示原文
  if (!env.AI || cleaned.length < 200) {
    return `📄 正文:\n<blockquote>${esc(truncate(cleaned, MAX_BODY))}</blockquote>`;
  }

  try {
    const model = env.AI_MODEL || AI_MODEL;
    const input = truncate(cleaned, AI_INPUT_LIMIT);
    const resp = await env.AI.run(model, {
      messages: [
        {
          role: "system",
          content:
            "你是邮件助手。用简体中文为邮件正文写摘要：" +
            "先一句话概括核心内容，再用 2-4 个要点列出关键信息（金额、时间、待办、链接等）。" +
            "保持客观，不要编造原文没有的信息，总长度控制在 200 字以内。直接输出摘要，不要寒暄。",
        },
        { role: "user", content: `主题：${subject}\n\n正文：\n${input}` },
      ],
      max_tokens: 512,
    });

    const summary = (resp && (resp.response ?? resp.result?.response) || "").trim();
    if (!summary) throw new Error("空摘要");

    return `🤖 <b>AI 摘要</b>\n<blockquote>${esc(summary)}</blockquote>`;
  } catch (e) {
    // 降级：摘要失败就展示截断原文，并标注
    return (
      `⚠️ <i>AI 摘要失败（${esc(e.message)}），展示原文</i>\n` +
      `📄 正文:\n<blockquote>${esc(truncate(cleaned, MAX_BODY))}</blockquote>`
    );
  }
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + " …（已截断）" : str;
}

// ── Telegram ──────────────────────────────────────────────
async function notifyTelegram(env, text) {
  const { TELEGRAM_TOKEN, CHAT_ID } = env;
  if (!TELEGRAM_TOKEN || !CHAT_ID) return; // 配置缺失则跳过，避免拼出坏请求

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    // HTML 解析出错时 Telegram 返回 400，降级为纯文本重试，保证通知能送达
    if (!resp.ok) {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: stripTags(text),
          disable_web_page_preview: true,
        }),
      });
    }
  } catch {
    // 网络异常等，静默放弃（已尽力）
  }
}

// HTML parse_mode 下需要转义的字符
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, "");
}

// ── 工具函数 ──────────────────────────────────────────────
// 解码 RFC 2047 MIME 编码的邮件头（如 =?UTF-8?B?...?= 或 =?UTF-8?Q?...?=）
function decodeMimeHeader(str) {
  if (!str) return str;
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (match, charset, encoding, encodedText) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        // Base64 解码
        const binary = atob(encodedText);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return new TextDecoder(charset).decode(bytes);
      } else if (encoding.toUpperCase() === 'Q') {
        // Quoted-Printable 解码
        const qp = encodedText.replace(/_/g, ' ')
                              .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        const bytes = new Uint8Array(qp.length);
        for (let i = 0; i < qp.length; i++) {
          bytes[i] = qp.charCodeAt(i);
        }
        return new TextDecoder(charset).decode(bytes);
      }
    } catch (e) {
      return match; // 解码失败就保留原样
    }
    return match;
  });
}

// 把流读成字符串，最多读取 maxBytes 字节（超出即停，正文解析够用）
async function streamToString(stream, maxBytes = Infinity) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      result += decoder.decode(value, { stream: true });
      if (total >= maxBytes) break;
    }
  } finally {
    reader.releaseLock();
  }
  return result;
}

function extractBody(rawEmail) {
  const splitIndex = rawEmail.indexOf("\r\n\r\n");
  if (splitIndex === -1) return "（无法解析正文）";

  const headerSection = rawEmail.slice(0, splitIndex);
  const bodyRaw = rawEmail.slice(splitIndex + 4);

  const contentType = (headerSection.match(/^Content-Type:\s*([^\r\n;]+)/im) || [])[1] || "";
  const encoding = (headerSection.match(/^Content-Transfer-Encoding:\s*([^\r\n]+)/im) || [])[1] || "";
  const charset = (headerSection.match(/charset="?([^"\r\n;]+)"?/i) || [])[1] || "utf-8";

  // 纯文本非 multipart
  if (contentType.includes("text/plain")) {
    return decodeBody(bodyRaw.trim(), encoding, charset);
  }

  // multipart：优先 text/plain，降级 text/html（boundary 只在 header 段找，避免误命中正文）
  if (contentType.includes("multipart")) {
    // 传 bodyRaw（不含主邮件头），否则 parts[0] 会带上主头里的 multipart 声明被误判而无限递归
    const result = extractFromMultipart(bodyRaw, headerSection, 0);
    if (result !== null) return result;
  }

  // HTML 直接发送
  if (contentType.includes("text/html")) {
    return stripHtml(decodeBody(bodyRaw.trim(), encoding, charset));
  }

  return "（无法解析正文）";
}

// 递归处理 multipart（支持嵌套，如 mixed 内含 alternative）
// bodySection 只含该层 multipart 的「正文部分」（不含声明它的那行头），boundary 从 headerSection 取
function extractFromMultipart(bodySection, headerSection, depth) {
  if (depth > 5) return null; // 防御：嵌套过深直接放弃，避免爆栈
  const boundaryMatch = headerSection.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) return null;

  const boundary = boundaryMatch[1].trim();
  const parts = bodySection.split("--" + boundary);
  let htmlFallback = null;

  for (const part of parts) {
    const partSplit = part.indexOf("\r\n\r\n");
    if (partSplit === -1) continue;

    const partHeaders = part.slice(0, partSplit);
    const partBody = part.slice(partSplit + 4).replace(/\r\n$/, "");
    const partType = (partHeaders.match(/Content-Type:\s*([^\r\n;]+)/i) || [])[1] || "";
    const partEncoding = (partHeaders.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i) || [])[1] || "";
    const partCharset = (partHeaders.match(/charset="?([^"\r\n;]+)"?/i) || [])[1] || "utf-8";

    // 嵌套 multipart：用「该 part 的 body」递归，boundary 从该 part 的 header 取
    if (partType.includes("multipart")) {
      const nested = extractFromMultipart(partBody, partHeaders, depth + 1);
      if (nested !== null) return nested;
      continue;
    }

    if (partType.includes("text/plain")) {
      return decodeBody(partBody.trim(), partEncoding, partCharset);
    }
    if (partType.includes("text/html")) {
      htmlFallback = stripHtml(decodeBody(partBody.trim(), partEncoding, partCharset));
    }
  }

  return htmlFallback; // 没有 plain 就用 html（可能为 null）
}

function decodeBody(text, encoding = "", charset = "utf-8") {
  const enc = encoding.trim().toLowerCase();

  if (enc === "base64") {
    try {
      const binary = atob(text.replace(/\s+/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return text;
    }
  }

  if (enc === "quoted-printable") {
    const qp = text.replace(/=\r\n/g, "").replace(/=\n/g, "");
    try {
      const bytes = [];
      for (let i = 0; i < qp.length; i++) {
        if (qp[i] === "=" && /[0-9A-Fa-f]{2}/.test(qp.slice(i + 1, i + 3))) {
          bytes.push(parseInt(qp.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(qp.charCodeAt(i));
        }
      }
      return new TextDecoder(charset).decode(new Uint8Array(bytes));
    } catch {
      return qp;
    }
  }

  return text;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
