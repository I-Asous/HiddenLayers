// Buddy's voice: Gemini writes the line, ElevenLabs speaks it. Both keys stay
// on the server. With a key missing the app still works — the buddy falls back
// to built-in lines and the browser's own speech synthesis.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SYSTEM_PROMPT =
  'You are a small, cheerful creature who loves walks. Reply in 1–2 short sentences, in character, reacting to the user\'s recent activity.';

const EVENT_LINES = {
  levelup: ['Level up! I feel stronger already!', 'Woohoo, I grew! Thanks for all the walks!'],
  evolve: ['Whoa, look at me! I evolved!', 'I feel brand new! We did this together!'],
  win: ['We won! That was amazing!', 'Victory! All those walks paid off!'],
  loss: ['Aww, we lost. Let\'s walk more and try again!', 'So close! A few more walks and we\'ll get them!'],
  draw: ['A tie! We were so evenly matched!'],
};

function fallbackChat(buddy, week, goal) {
  const today = week.at(-1).steps;
  const active = week.filter((d) => d.steps > 0).length;
  if (today >= goal) return `We smashed our goal today! ${today.toLocaleString('en-US')} steps, I'm so proud of us!`;
  if (today > 0) return `${today.toLocaleString('en-US')} steps so far today! Keep going, my little legs love it!`;
  if (active === 0) return 'I\'ve been napping all week. Can we go for a tiny walk together?';
  return `We walked on ${active} of the last 7 days! Let's get out there again today!`;
}

async function geminiLine(buddy, week, goal) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const activity = week.map((d) => `${d.date}: ${d.steps}`).join(', ');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{
        role: 'user',
        parts: [{
          text: `Your name is ${buddy.name}. You are a ${buddy.species}, at the "${buddy.stage}" stage of growing up. ` +
            `The user's daily goal is ${goal} steps. Their steps for the last 7 days, oldest first ` +
            `(the last entry is today): ${activity}.`,
        }],
      }],
      generationConfig: { temperature: 1, maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
  if (!text) throw new Error('Gemini returned no text');
  return text.slice(0, 300);
}

export async function buddyLine({ event, buddy, week, goal }) {
  if (event !== 'chat') {
    const lines = EVENT_LINES[event];
    return { text: lines[Math.floor(Math.random() * lines.length)], source: 'builtin' };
  }
  if (process.env.GEMINI_API_KEY) {
    try {
      return { text: await geminiLine(buddy, week, goal), source: 'gemini' };
    } catch (err) {
      console.error('[ai]', err.message);
    }
  }
  return { text: fallbackChat(buddy, week, goal), source: 'builtin' };
}

export const isBuddyEvent = (event) => event === 'chat' || event in EVENT_LINES;

function ttsConfig() {
  return {
    voice: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
    model: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
  };
}

const inFlight = new Map();

// Returns the cache file name for the spoken text, or null if speech is
// unavailable. Audio is cached on disk by voice + text, so a repeated line
// never costs credits twice.
export async function speak(text, cacheDir) {
  if (!process.env.ELEVENLABS_API_KEY) return null;
  const { voice, model } = ttsConfig();
  const name = `${createHash('sha256').update(`${voice}|${model}|${text}`).digest('hex')}.mp3`;
  const file = path.join(cacheDir, name);
  if (existsSync(file)) return name;
  if (!inFlight.has(name)) {
    inFlight.set(name, (async () => {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY },
          body: JSON.stringify({ text, model_id: model }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    })().finally(() => inFlight.delete(name)));
  }
  try {
    await inFlight.get(name);
    return name;
  } catch (err) {
    console.error('[ai]', err.message);
    return null;
  }
}
