/**
 * WhatsApp chat export parsing + knowledge extraction helpers.
 * Official exports are usually a .zip containing one .txt (and optional media).
 */

// Explicit ranges (Mkhedruli + Mtavruli) — avoid \p{Script=...} for older Node / discovery.
const GEORGIAN_CHAR_RE = /[\u10A0-\u10FF\u1C90-\u1CBF]/;
const LETTER_RE = /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u10A0-\u10FF\u1C90-\u1CBF\u4E00-\u9FFF]/g;

/** True when a large share of letters in the text are Georgian script. */
function isGeorgianHeavy(text, threshold = 0.35) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  const letters = raw.match(LETTER_RE) || [];
  if (letters.length < 3) return false;
  let georgian = 0;
  for (const ch of letters) {
    if (GEORGIAN_CHAR_RE.test(ch)) georgian += 1;
  }
  return georgian / letters.length >= threshold;
}

/** Drop lines / messages that are Georgian-heavy (owner handles those manually). */
function filterOutGeorgianMessages(messages) {
  return (messages || []).filter((m) => !isGeorgianHeavy(m.content));
}

/**
 * Parse WhatsApp export .txt into { timestamp, sender, content } rows.
 * Supports common Android / iOS export formats.
 */
function parseWhatsAppExport(rawText) {
  const text = String(rawText || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  // [DD/MM/YYYY, HH:MM:SS] Name: message   (iOS)
  // [DD/MM/YYYY, HH:MM:SS AM/PM] Name: message
  const iosRe = /^\[(\d{1,2}[./]\d{1,2}[./]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\]\s+([^:]+):\s([\s\S]*)$/i;
  // DD/MM/YYYY, HH:MM - Name: message   (Android)
  const androidRe = /^(\d{1,2}[./]\d{1,2}[./]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\s+-\s+([^:]+):\s([\s\S]*)$/i;
  // System / no-colon variants: "DD/MM/YYYY, HH:MM - Messages and calls are…"
  const androidSystemRe = /^(\d{1,2}[./]\d{1,2}[./]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\s+-\s+([\s\S]+)$/i;

  const messages = [];
  let current = null;

  const pushCurrent = () => {
    if (!current) return;
    const content = String(current.content || '').trim();
    if (!content) {
      current = null;
      return;
    }
    // Skip export boilerplate / media placeholders that teach nothing useful alone
    const lower = content.toLowerCase();
    if (
      lower.includes('messages and calls are end-to-end encrypted') ||
      lower.includes('end-to-end encrypted') ||
      lower === '<media omitted>' ||
      lower === 'null' ||
      lower.startsWith('you deleted this message') ||
      lower.startsWith('this message was deleted')
    ) {
      current = null;
      return;
    }
    messages.push(current);
    current = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      if (current) current.content += '\n';
      continue;
    }

    let match = line.match(iosRe);
    let kind = 'ios';
    if (!match) {
      match = line.match(androidRe);
      kind = 'android';
    }

    if (match) {
      pushCurrent();
      current = {
        timestamp: `${match[1]} ${match[2]}`,
        sender: String(match[3] || '').trim(),
        content: String(match[4] || ''),
        kind,
      };
      continue;
    }

    // System line without "Name:" — treat as system, skip for learning
    const sys = line.match(androidSystemRe);
    if (sys && !line.includes(': ')) {
      pushCurrent();
      continue;
    }

    if (current) {
      current.content += `\n${line}`;
    }
  }
  pushCurrent();

  return messages;
}

/** Guess which sender is the business/host from frequency of known host names + message volume. */
function inferHostSender(messages, hintNames = []) {
  const counts = new Map();
  for (const m of messages) {
    const key = m.sender;
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const hints = hintNames.map((n) => String(n || '').toLowerCase()).filter(Boolean);
  for (const [name] of counts) {
    const lower = name.toLowerCase();
    if (
      hints.some((h) => lower.includes(h)) ||
      lower.includes('maxela') ||
      lower.includes('freedom') ||
      lower.includes('midamo') ||
      lower.includes('orbeliani') ||
      lower.includes('business')
    ) {
      return name;
    }
  }
  // Fallback: most frequent sender (host usually talks a lot in support chats)
  let best = '';
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

function formatMessagesForLearning(messages, hostSender) {
  return messages
    .map((m) => {
      const role = m.sender === hostSender ? 'Host' : 'Guest';
      return `${role} (${m.sender}): ${m.content}`;
    })
    .join('\n');
}

const LEARNING_SYSTEM_PROMPT = `You extract reusable guest-support knowledge from a WhatsApp host↔guest chat for Maxela Apartments (Tbilisi short-term rentals).

Rules:
- Ignore any Georgian-language content entirely (do not translate it, do not learn from it).
- Only keep clear, reusable question → answer pairs that would help answer a future English-speaking guest.
- Prefer host answers that are factual (check-in, WiFi, parking, hot water, bag storage, smoking, gym, airport transfer, booking links, room types).
- Skip greetings, logistics unique to one stay, personal chit-chat, complaints with no reusable resolution, and anything that required a one-off human exception with no general rule.
- Rewrite answers in short natural English matching this tone: no exclamation marks, no bullet lists, 1-3 sentences.
- topic should be a short slug like parking, hot_water, early_checkin, wifi, smoking, bag_storage.

Return ONLY valid JSON (no markdown fence) as:
{"items":[{"topic":"...","guestQuestion":"...","hostAnswer":"...","notes":"..."}]}
If nothing useful, return {"items":[]}.`;

/**
 * Ask Claude to extract knowledge items from already-filtered chat text.
 * callClaude: async ({ system, messages, maxTokens }) => string
 */
async function extractKnowledgeFromChat(callClaude, conversationText) {
  const raw = await callClaude({
    system: LEARNING_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: conversationText.slice(0, 120000) }],
    maxTokens: 2500,
  });

  const cleaned = String(raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => ({
        topic: String(item.topic || 'general').trim().slice(0, 80),
        guestQuestion: String(item.guestQuestion || item.question || '').trim().slice(0, 500),
        hostAnswer: String(item.hostAnswer || item.answer || '').trim().slice(0, 800),
        notes: String(item.notes || '').trim().slice(0, 300),
      }))
      .filter((item) => item.guestQuestion && item.hostAnswer && !isGeorgianHeavy(`${item.guestQuestion} ${item.hostAnswer}`));
  } catch (err) {
    console.error('extractKnowledgeFromChat: JSON parse failed', err, cleaned.slice(0, 400));
    return [];
  }
}

/**
 * Full pipeline: parse export → drop Georgian → extract knowledge.
 * Returns { messages, filtered, hostSender, items, skippedGeorgian, stats }
 */
async function learnFromWhatsAppExport(callClaude, rawText, { hostHints = [] } = {}) {
  const messages = parseWhatsAppExport(rawText);
  const skippedGeorgian = messages.filter((m) => isGeorgianHeavy(m.content)).length;
  const filtered = filterOutGeorgianMessages(messages);
  const hostSender = inferHostSender(filtered, hostHints);
  const conversationText = formatMessagesForLearning(filtered, hostSender);

  let items = [];
  if (filtered.length >= 2 && conversationText.length > 40) {
    items = await extractKnowledgeFromChat(callClaude, conversationText);
  }

  return {
    messages,
    filtered,
    hostSender,
    items,
    skippedGeorgian,
    stats: {
      parsed: messages.length,
      kept: filtered.length,
      skippedGeorgian,
      learned: items.length,
    },
  };
}

/** Build a prompt block from active knowledge docs. */
function buildKnowledgeContext(knowledgeDocs, limit = 25) {
  const rows = (knowledgeDocs || []).slice(0, limit);
  if (!rows.length) return '';
  const lines = rows.map((k, i) => {
    const topic = k.topic || 'general';
    const q = k.guestQuestion || '';
    const a = k.hostAnswer || '';
    return `${i + 1}. [${topic}] Guest: ${q} → Reply: ${a}`;
  });
  return [
    'LEARNED FROM PAST HOST CHATS (prefer these answers when they match the guest question; still follow TONE RULES and ESCALATE if unsure):',
    ...lines,
  ].join('\n');
}

module.exports = {
  isGeorgianHeavy,
  filterOutGeorgianMessages,
  parseWhatsAppExport,
  inferHostSender,
  formatMessagesForLearning,
  extractKnowledgeFromChat,
  learnFromWhatsAppExport,
  buildKnowledgeContext,
  LEARNING_SYSTEM_PROMPT,
};
