/**
 * The morning note.
 *
 * A bot token and a chat id are all this needs — no mail server, no OAuth, no
 * per-message cost, and the Project Office is on Telegram already. Without the
 * two variables nothing is sent and nothing breaks.
 */
export const telegramReady = () =>
  !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

export async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { sent: false, reason: 'not configured' };

  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const r = await fetch(`${base}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chat, text: text.slice(0, 4000),
      parse_mode: 'HTML', disable_web_page_preview: true,
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) return { sent: false, reason: j.description || `Telegram replied ${r.status}` };
  return { sent: true, reason: '' };
}

/**
 * The backup itself, not a note about it.
 *
 * A message can say the project was copied; only the file is the copy. This
 * posts it as a document, which Telegram keeps and the project office can
 * download or forward months later — the point of the whole exercise being a
 * copy that does not live where the database lives.
 *
 * Telegram takes up to 50 MB this way. The project gzips to well under one.
 */
export async function sendTelegramFile(
  file: Uint8Array, filename: string, caption = '',
): Promise<{ sent: boolean; reason: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { sent: false, reason: 'not configured' };

  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const body = new FormData();
  body.set('chat_id', chat);
  if (caption) { body.set('caption', caption.slice(0, 1000)); body.set('parse_mode', 'HTML'); }
  body.set('document', new Blob([new Uint8Array(file)],
    { type: 'application/gzip' }), filename);

  const r = await fetch(`${base}/bot${token}/sendDocument`, { method: 'POST', body });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false)
    return { sent: false, reason: j.description || `Telegram replied ${r.status}` };
  return { sent: true, reason: '' };
}

/**
 * Which chats this bot can post to.
 *
 * Setting one of these up founders on the chat id: it is not shown anywhere in
 * Telegram, and the usual advice is to paste a token into somebody else's web
 * page. Instead the bot is asked what it has heard — send it any message, or
 * add it to the channel, press this, and the id is there to copy.
 */
export async function telegramChats(): Promise<{ ok: boolean; reason: string;
                                                 chats: { id: string; name: string; kind: string }[] }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, reason: 'No bot token is set on the server.', chats: [] };
  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

  const r = await fetch(`${base}/bot${token}/getUpdates?limit=100`);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false)
    return { ok: false, reason: j.description || `Telegram replied ${r.status}`, chats: [] };

  const seen = new Map<string, { id: string; name: string; kind: string }>();
  for (const u of (j.result || []) as any[]) {
    const m = u.message || u.channel_post || u.edited_message || u.edited_channel_post
            || u.my_chat_member || {};
    const c = m.chat;
    if (!c || seen.has(String(c.id))) continue;
    seen.set(String(c.id), {
      id: String(c.id),
      name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ')
            || c.username || 'unnamed',
      kind: c.type || '',
    });
  }
  return { ok: true, reason: '', chats: [...seen.values()] };
}
