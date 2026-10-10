// Buddy's voice: Gemini writes the line, ElevenLabs speaks it. Both keys stay
// on the server. With a key missing the app still works — the buddy falls back
// to built-in lines and the browser's own speech synthesis.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ElevenLabs premade voices a personality can pick from. The descriptions are
// what Gemini reads when it chooses one. neverTags are audio tags that would
// sound out of character in that voice; they're forbidden and stripped.
export const VOICES = {
  bubbly: { id: 'Nggzl2QAXh3OijoXD116', desc: 'bright, playful, bubbly' },
  australian: { id: 'fjgAVa6FpNYGo4UpjqML', desc: 'cheerful, friendly, Australian' },
  grampa: { id: 'MKlLqCItoCkvdhrxgtLv', desc: 'old, honest, grumpy' },
  calm: { id: 'esy0r39YPLQjOczyOib8', desc: 'calculating, calm' },
  energetic: { id: 'WtA85syCrJwasGeHGH2p', desc: 'loud, excitable, energetic' },
  posh: { id: 'nDJIICjR9zfJExIFeSCN', desc: 'warm, proper, a little posh' },
  gravelly: { id: 'wo6udizrrtpIxWGp2qJk', desc: 'husky, gravelly, grumpy' },
  military: { id: 'DGzg6RaUqxGRTHSBjfgF', desc: 'stern, commanding, military', neverTags: ['giggles'] },
};

// What players pick from, and what "Surprise me" falls back to when there is
// no Gemini key or Gemini fails.
export const PERSONALITY_PRESETS = [
  { id: 'giggler', name: 'Giggler', traits: ['Bubbly', 'Curious', 'Clumsy'], quirk: 'Loves snacks', style: 'talks fast and giggles a lot', voice: 'bubbly' },
  { id: 'diva', name: 'Diva', traits: ['Dramatic', 'Sarcastic', 'Vain'], quirk: 'Thinks it is royalty', style: 'speaks like a theatrical diva', voice: 'posh' },
  { id: 'grump', name: 'Grump', traits: ['Grumpy', 'Loyal', 'Lazy'], quirk: 'Hates mornings', style: 'grumbles, but secretly cares', voice: 'gravelly' },
  { id: 'coach', name: 'Coach', traits: ['Hyper', 'Competitive', 'Brave'], quirk: 'Counts every step out loud', style: 'shouts like a sports coach', voice: 'energetic' },
  { id: 'dreamer', name: 'Dreamer', traits: ['Calm', 'Kind', 'Dreamy'], quirk: 'Collects pretty leaves', style: 'speaks softly, like a bedtime story', voice: 'calm' },
  { id: 'sage', name: 'Sage', traits: ['Wise', 'Patient', 'Nosy'], quirk: 'Has a proverb for everything', style: 'talks like an ancient sage', voice: 'grampa' },
  { id: 'surfer', name: 'Surfer', traits: ['Sunny', 'Adventurous', 'Laid-back'], quirk: 'Calls everyone mate', style: 'chats like a friendly surfer', voice: 'australian' },
  { id: 'sergeant', name: 'Sergeant', traits: ['Disciplined', 'Bold', 'Strict'], quirk: 'Salutes every tree', style: 'barks orders like a drill sergeant', voice: 'military' },
];

const EVENT_PROMPTS = {
  levelup: 'You just leveled up.',
  evolve: 'You just evolved into a new stage.',
  win: 'You just won a battle against another buddy.',
  loss: 'You just lost a battle against another buddy.',
  draw: 'Your battle against another buddy just ended in a draw.',
};

// How each mood (see moodFor in game.js) colors a line and its delivery.
// Stability 0 is v3's "Creative" mode, the most expressive; 0.5 is "Natural", calmer.
export const MOOD_STYLES = {
  upset: {
    feeling: 'upset about losing your last two battles, but you still believe in your walker and want to ' +
      'cheer them on to train and win the next one',
    tags: '[sighs], [determined]',
    stability: 0,
  },
  proud: { feeling: 'proud of your walking streak together', tags: '[laughs], [excited]', stability: 0 },
  happy: { feeling: 'happy, you hit today\'s step goal', tags: '[giggles], [excited]', stability: 0 },
  lonely: { feeling: 'lonely, you miss going on walks', tags: '[sighs], [whispers]', stability: 0.5 },
  sleepy: { feeling: 'sleepy, you haven\'t walked yet today', tags: '[yawns], [sighs]', stability: 0.5 },
  eager: { feeling: 'eager to finish today\'s walking goal', tags: '[excited], [gasps]', stability: 0 },
};

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

// `contents` is a prompt string, or a whole conversation of user/model turns.
async function gemini(system, contents, generationConfig) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: typeof contents === 'string' ? [{ role: 'user', parts: [{ text: contents }] }] : contents,
      generationConfig: { temperature: 1, maxOutputTokens: 1024, ...generationConfig },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
  if (!text) throw new Error('Gemini returned no text');
  return text;
}

const AUDIO_TAGS = ['giggles', 'laughs', 'sighs', 'whispers', 'excited', 'sarcastic', 'gasps', 'groans', 'yawns'];
const neverTagsOf = (buddy) => VOICES[buddy.personality.voice]?.neverTags ?? [];

function systemPrompt(buddy) {
  const p = buddy.personality;
  const never = neverTagsOf(buddy);
  const tags = AUDIO_TAGS.filter((tag) => !never.includes(tag)).map((tag) => `[${tag}]`).join(', ');
  return `You are ${buddy.name}, a small ${buddy.species} at the "${buddy.stage}" stage of growing up, ` +
    'the virtual pet of someone who walks to make you grow. ' +
    `Your personality: ${p.traits.join(', ')}. Speaking style: ${p.style}. ` +
    `Quirk: ${p.quirk}. The quirk is a background detail: bring it up only rarely, never two lines in a row. ` +
    'Each message is a new moment in one ongoing life together. Never repeat a line, joke or topic you already used; ' +
    'react to what is happening now. ' +
    'Reply with ONE short line of at most 12 words, always in character. ' +
    'Keep all your personality and energy: short means punchy, not bland. ' +
    'Sound like a real creature blurting something out, not an assistant or a motivational poster. ' +
    'Fragments are fine. Use casual words, slang and fillers (like "ugh", "okay so", "honestly") ' +
    'only when your speaking style would, and not in every line. ' +
    'Don\'t open with stock praise like "Great job!" or "Wow!", and don\'t sum things up. ' +
    'Never use words like delve, testament, tapestry, journey, crucial, foster, ' +
    'or phrases like "keep up the great work" or "you\'ve got this". ' +
    'Your words are spoken aloud by a voice actor. Never use emojis, asterisks, action text like *giggles*, or markdown. ' +
    `To show how you sound, you may add up to 2 audio tags in square brackets, e.g. ${tags}. ` +
    'Put each tag right before the words it affects.' +
    (never.length ? ` Never use ${never.map((tag) => `[${tag}]`).join(' or ')}: it doesn't fit you, whatever your mood.` : '');
}

// Gemini can still slip in a tag the buddy's voice must never make.
export function dropTags(text, never) {
  return never.reduce((t, tag) => t.replace(new RegExp(`\\[${tag}\\]`, 'gi'), ' '), text).replace(/\s+/g, ' ').trim();
}

// Gemini doesn't always follow the rules above. cleanLine keeps the audio tags
// for ElevenLabs; stripTags gives the text for the speech bubble.
export function cleanLine(text) {
  return text
    .replace(/\*[^*]*\*|(^|\s)_[^_]*_(?=\s|$)/g, ' ')
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, '')
    .replace(/[*#]/g, '')
    .replace(/\[[^\]]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const stripTags = (text) => text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();

// What is happening right now, as told to the buddy, starting with its mood.
export function situationFor(event, week, goal, mood) {
  const { feeling, tags } = MOOD_STYLES[mood];
  const feel = `Right now you feel ${feeling}; let it color your reply (fitting tags: ${tags}). `;
  if (event !== 'chat') return feel + EVENT_PROMPTS[event] + ' React to it.';
  const activity = week.map((d) => `${d.date}: ${d.steps}`).join(', ');
  return feel + `React to the user's recent walking. Their daily goal is ${goal} steps. Their steps for the ` +
    `last 7 days, oldest first (the last entry is today): ${activity}.`;
}

// `memory` is the buddy's recent exchanges, oldest first: [{ situation, reply }].
// They go to Gemini as the conversation so far, so the buddy remembers what it
// said and doesn't repeat itself.
async function geminiLine(situation, buddy, memory) {
  const contents = memory.flatMap((m) => [
    { role: 'user', parts: [{ text: m.situation }] },
    { role: 'model', parts: [{ text: m.reply }] },
  ]);
  contents.push({ role: 'user', parts: [{ text: situation }] });
  return (await gemini(systemPrompt(buddy), contents)).slice(0, 160);
}

export async function buddyLine({ event, buddy, week, goal, mood, memory = [] }) {
  if (process.env.GEMINI_API_KEY) {
    try {
      const situation = situationFor(event, week, goal, mood);
      const speech = dropTags(cleanLine(await geminiLine(situation, buddy, memory)), neverTagsOf(buddy));
      // A reply that was only "*giggles*" or "[laughs]" has nothing left to show.
      if (!stripTags(speech)) throw new Error('Gemini line was empty after clean-up');
      return { text: stripTags(speech), speech, situation, source: 'gemini' };
    } catch (err) {
      console.error('[ai]', err.message);
    }
  }
  if (event !== 'chat') {
    const lines = EVENT_LINES[event];
    const text = lines[Math.floor(Math.random() * lines.length)];
    return { text, speech: text, source: 'builtin' };
  }
  const text = fallbackChat(buddy, week, goal);
  return { text, speech: text, source: 'builtin' };
}

const randomPreset = () => PERSONALITY_PRESETS[Math.floor(Math.random() * PERSONALITY_PRESETS.length)];

async function geminiPersonality(buddy) {
  const text = await gemini(
    'You invent fun, distinct personalities for small virtual pet creatures. Be original and surprising.',
    `Invent a personality for ${buddy.name}, a ${buddy.species}. Pick the voice that fits it best from: ` +
      Object.entries(VOICES).map(([key, v]) => `${key} (${v.desc})`).join(', ') + '.',
    {
      temperature: 1.3,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          traits: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Exactly 3 one-word traits, capitalized' },
          quirk: { type: 'STRING', description: 'A short quirk, at most 5 words' },
          style: { type: 'STRING', description: 'How it talks, e.g. "speaks in dramatic whispers"' },
          voice: { type: 'STRING', enum: Object.keys(VOICES) },
        },
        required: ['traits', 'quirk', 'style', 'voice'],
      },
    },
  );
  const p = JSON.parse(text);
  const traits = Array.isArray(p.traits) ? p.traits.map((t) => String(t).trim().slice(0, 16)).filter(Boolean) : [];
  if (traits.length < 3 || !p.quirk || !p.style || !(p.voice in VOICES)) throw new Error('Gemini personality malformed');
  return {
    traits: traits.slice(0, 3), quirk: String(p.quirk).slice(0, 40), style: String(p.style).slice(0, 100), voice: p.voice,
  };
}

export async function generatePersonality(buddy) {
  if (process.env.GEMINI_API_KEY) {
    try {
      return await geminiPersonality(buddy);
    } catch (err) {
      console.error('[ai]', err.message);
    }
  }
  return randomPreset();
}

export const isBuddyEvent = (event) => event === 'chat' || event in EVENT_LINES;
export const BUDDY_EVENTS = Object.keys(EVENT_LINES);

function ttsConfig() {
  return {
    voice: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
    model: process.env.ELEVENLABS_MODEL || 'eleven_v3',
  };
}

const inFlight = new Map();

// ElevenLabs caps how many requests may run at once (5 on this plan), so at
// most 3 run here and the rest wait. Live lines jump the queue ahead of
// pre-generated ones, so preparing lines never holds up a Talk.
const MAX_TTS = 3;
let ttsRunning = 0;
const ttsQueue = [];
function ttsSlot(background) {
  return new Promise((resolve) => {
    if (background) ttsQueue.push(resolve);
    else ttsQueue.unshift(resolve);
    nextTts();
  });
}
function nextTts() {
  while (ttsRunning < MAX_TTS && ttsQueue.length) {
    ttsRunning++;
    ttsQueue.shift()();
  }
}

// Starts generating speech and returns its cache file name right away, or null
// if speech is unavailable; GET /api/tts/<name> waits for it with waitForSpeech.
// Audio is cached on disk by voice + text, so a repeated line never costs
// credits twice.
export function startSpeech(text, cacheDir, voiceKey, { background = false, stability = 0 } = {}) {
  if (!process.env.ELEVENLABS_API_KEY) return null;
  const { model } = ttsConfig();
  const voice = VOICES[voiceKey]?.id ?? ttsConfig().voice;
  // Only v3 performs audio tags; older models would read "[giggles]" aloud.
  if (!model.startsWith('eleven_v3')) text = stripTags(text);
  const name = `${createHash('sha256').update(`${voice}|${model}|${stability}|${text}`).digest('hex')}.mp3`;
  const file = path.join(cacheDir, name);
  if (!existsSync(file) && !inFlight.has(name)) {
    inFlight.set(name, (async () => {
      await ttsSlot(background);
      try {
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY },
            body: JSON.stringify({ text, model_id: model, voice_settings: { stability } }),
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      } finally {
        ttsRunning--;
        nextTts();
      }
    })().catch((err) => console.error('[ai]', err.message)).finally(() => inFlight.delete(name)));
  }
  return name;
}

export const waitForSpeech = (name) => inFlight.get(name) ?? Promise.resolve();
/** Resolves once no speech is being generated or waiting its turn. */
export const allSpeechDone = () => Promise.all(inFlight.values());
