'use strict';

const logger = require('../logger');

// Voice-note transcription via Whisper. Configured at the platform level with
// GROQ_API_KEY (whisper-large-v3, fast + generous free tier) or OPENAI_API_KEY
// (whisper-1). With neither set, transcription is unavailable and the agent
// falls back to asking the client to type.
const PROVIDERS = [
  {
    name: 'groq',
    key: () => process.env.GROQ_API_KEY,
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3',
  },
  {
    name: 'openai',
    key: () => process.env.OPENAI_API_KEY,
    url: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
  },
];

function available() {
  return PROVIDERS.some((p) => p.key());
}

function extFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'ogg'; // WhatsApp voice notes
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  return 'ogg';
}

// media: { base64, mime } → transcript string, or null when unavailable/failed.
async function transcribe(media) {
  const provider = PROVIDERS.find((p) => p.key());
  if (!provider || !media?.base64) return null;
  try {
    const buf = Buffer.from(media.base64, 'base64');
    if (!buf.length || buf.length > 24 * 1024 * 1024) return null;
    const form = new FormData();
    form.append('model', provider.model);
    form.append('file', new Blob([buf], { type: media.mime || 'audio/ogg' }), `note.${extFor(media.mime)}`);
    const res = await fetch(provider.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${provider.key()}` },
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ provider: provider.name, status: res.status, body: body.slice(0, 200) }, 'transcription failed');
      return null;
    }
    const out = await res.json();
    const text = String(out.text || '').trim();
    return text || null;
  } catch (err) {
    logger.warn({ err: err.message }, 'transcription error');
    return null;
  }
}

module.exports = { transcribe, available };
