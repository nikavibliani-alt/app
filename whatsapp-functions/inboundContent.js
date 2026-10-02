'use strict';

// How each incoming WhatsApp (Meta Cloud API) message type is stored and
// whether the bot should run for it. Pure, so every type is unit-testable.
//
// Returns { content, media, action }:
//   content — the text stored in whatsapp_conversations/{phone}/messages
//   media   — { type: 'image', id, mimeType } for photos (the media id only,
//             never the image itself; the worker downloads it when needed)
//   action  — 'reply'      store it and run the bot
//             'store_only' store it, but no bot run (stickers)
//             'ignore'     don't store, no bot run (reactions)

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const withCaption = (placeholder, caption) => (clean(caption) ? `${placeholder} ${clean(caption)}` : placeholder);

function describeInbound(msg) {
  const m = msg || {};
  if (m.text?.body) return { content: m.text.body, media: null, action: 'reply' };

  switch (m.type) {
    case 'reaction':
      // A 👍 on one of our messages: nothing to answer, nothing to alert.
      return { content: `[reaction: ${m.reaction?.emoji || 'removed'}]`, media: null, action: 'ignore' };

    case 'sticker':
      // Treated like a reaction: kept in the history, but no bot run of its own.
      // If the guest also writes text, that text's run sees the sticker in history.
      return { content: '[sticker]', media: null, action: 'store_only' };

    case 'image':
      return {
        content: withCaption('[image]', m.image?.caption),
        media: m.image?.id ? { type: 'image', id: String(m.image.id), mimeType: m.image.mime_type || '' } : null,
        action: 'reply',
      };

    case 'video':
      return { content: withCaption('[video]', m.video?.caption), media: null, action: 'reply' };

    case 'audio':
    case 'voice':
      return { content: '[audio]', media: null, action: 'reply' };

    case 'location': {
      const loc = m.location || {};
      const place = [clean(loc.name), clean(loc.address)].filter(Boolean).join(', ');
      const coords = [loc.latitude, loc.longitude].filter((v) => v !== undefined && v !== null).join(', ');
      return { content: `[location: ${[place, coords].filter(Boolean).join(', ') || 'unknown'}]`, media: null, action: 'reply' };
    }

    case 'document':
      return { content: withCaption(`[document: ${clean(m.document?.filename) || 'file'}]`, m.document?.caption), media: null, action: 'reply' };

    case 'button':
      // Quick-reply button on one of our templates: its text is the message.
      if (clean(m.button?.text)) return { content: clean(m.button.text), media: null, action: 'reply' };
      break;

    case 'interactive': {
      const title = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
      if (clean(title)) return { content: clean(title), media: null, action: 'reply' };
      break;
    }

    default:
      break;
  }
  return { content: '[unsupported]', media: null, action: 'reply' };
}

module.exports = { describeInbound };
