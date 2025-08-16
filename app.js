const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

const EDGE_PROGRESS_URL = process.env.EDGE_PROGRESS_URL || '';
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const ASR_MODEL = process.env.ASR_MODEL || 'whisper-1';

if (!OPENAI_API_KEY) console.warn('[WARN] Missing OPENAI_API_KEY');
if (!EDGE_PROGRESS_URL) console.warn('[WARN] Missing EDGE_PROGRESS_URL');
if (!WORKER_TOKEN) console.warn('[WARN] Missing WORKER_TOKEN');

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

async function postProgress(summaryId, stage, percent, note, partial) {
  if (!EDGE_PROGRESS_URL || !WORKER_TOKEN || !summaryId) return;
  try {
    await fetch(EDGE_PROGRESS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-token': WORKER_TOKEN },
      body: JSON.stringify({ summaryId, stage, percent, note, partial })
    });
  } catch (e) { console.error('postProgress failed:', e?.message || e); }
}

// ---------------- Video helpers ----------------
function detectPlatformFromUrl(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'facebook';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  return 'unknown';
}

async function callOpenAIChat(body) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${txt.slice(0,300)}`);
  let json; try { json = JSON.parse(txt); } catch { throw new Error(`OpenAI JSON parse failed: ${txt.slice(0,300)}`); }
  const content = json?.choices?.[0]?.message?.content ?? '';
  return { json, content, raw: txt };
}
function parseJsonFromContent(content, fallback = {}) {
  const first = content.indexOf('{'), last = content.lastIndexOf('}');
  const payload = (first >= 0 && last > first) ? content.slice(first, last + 1) : content;
  try { return JSON.parse(payload); } catch { return fallback; }
}



async function extractVideoInfo(url) {
  const platform = detectPlatformFromUrl(url);
  return new Promise((resolve) => {
    let command;
    switch (platform) {
      case 'instagram':
        command = `yt-dlp --no-download --print-json --no-warnings --user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15" "${url}"`;
        break;
      case 'tiktok':
        command = `yt-dlp --no-download --print-json --no-warnings --user-agent "Mozilla/5.0 (Linux; Android 10; SM-G973F)" "${url}"`;
        break;
      case 'facebook':
        command = `yt-dlp --no-download --print-json --no-warnings --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" "${url}"`;
        break;
      case 'youtube':
      default:
        command = `yt-dlp --no-download --print-json --no-warnings --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --extractor-args "youtube:player_client=android,web" "${url}"`;
        break;
    }
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`${platform} extraction error:`, (stderr || '').slice(0, 400));
        return resolve({ title: `${platform} video`, duration: null, thumbnail: null });
      }
      try {
        const info = JSON.parse(stdout);
        resolve({ title: info.title || 'Untitled Video', duration: info.duration || null, thumbnail: info.thumbnail || null });
      } catch {
        resolve({ title: `${platform} video`, duration: null, thumbnail: null });
      }
    });
  });
}

async function downloadAndExtractAudio(url) {
  // Produces a WAV path in a temp dir
  const tempDir = path.join(os.tmpdir(), 'audio-' + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });
  const outBase = path.join(tempDir, 'audio');
  const platform = detectPlatformFromUrl(url);

  const strategies = {
    instagram: [
      `yt-dlp -f "best[ext=mp4]" --extract-audio --audio-format wav --user-agent "Instagram 219.0.0.12.117 Android" -o "${outBase}.%(ext)s" "${url}"`,
      `yt-dlp -f "best" --extract-audio --audio-format wav --user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)" -o "${outBase}.%(ext)s" "${url}"`,
      `yt-dlp --extract-audio --audio-format wav -o "${outBase}.%(ext)s" "${url}"`
    ],
    tiktok: [
      `yt-dlp -f "best" --extract-audio --audio-format wav --user-agent "Mozilla/5.0 (Linux; Android 10; SM-G973F)" -o "${outBase}.%(ext)s" "${url}"`,
      `yt-dlp --extract-audio --audio-format wav -o "${outBase}.%(ext)s" "${url}"`
    ],
    facebook: [
      `yt-dlp -f "best[height<=720]" --extract-audio --audio-format wav --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -o "${outBase}.%(ext)s" "${url}"`,
      `yt-dlp --extract-audio --audio-format wav -o "${outBase}.%(ext)s" "${url}"`
    ],
    youtube: [
      `yt-dlp -f "bestaudio/best" --extract-audio --audio-format wav --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" --extractor-args "youtube:player_client=android" -o "${outBase}.%(ext)s" "${url}"`,
      `yt-dlp --extract-audio --audio-format wav -o "${outBase}.%(ext)s" "${url}"`
    ],
    unknown: [`yt-dlp --extract-audio --audio-format wav -o "${outBase}.%(ext)s" "${url}"`]
  }[platform] || [];

  for (const cmd of strategies) {
    try {
      await new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 200, timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
      });
      // Find a produced file
      const files = fs.readdirSync(tempDir).filter(f => f.startsWith('audio_') || f.startsWith('audio.') || f.startsWith('audio'));
      if (files.length) return path.join(tempDir, files[0]);
    } catch (e) {
      console.log('Audio strategy failed, trying next…');
    }
  }
  throw new Error('Audio extraction failed');
}

async function compressIfNeeded(wavPath) {
  // Ensure <= 24MB for Whisper
  const mb = fs.statSync(wavPath).size / (1024 * 1024);
  if (mb <= 24) return wavPath;
  const out = wavPath.replace(/\.wav$/i, '_compressed.wav');
  await new Promise((resolve, reject) => {
    exec(`ffmpeg -y -i "${wavPath}" -ac 1 -ar 16000 -b:a 32k "${out}"`, (err) => err ? reject(err) : resolve());
  });
  return out;
}

async function segmentAudio(wavPath, segmentSec = 60) {
  const dir = path.join(path.dirname(wavPath), 'chunks');
  fs.mkdirSync(dir, { recursive: true });
  const pattern = path.join(dir, 'part_%03d.wav');
  await new Promise((resolve, reject) => {
    exec(`ffmpeg -hide_banner -loglevel error -i "${wavPath}" -f segment -segment_time ${segmentSec} -c copy "${pattern}"`, (err) => err ? reject(err) : resolve());
  });
  return fs.readdirSync(dir).filter(f => f.startsWith('part_')).map(f => path.join(dir, f)).sort();
}

async function synthesizeRecipe(transcript, videoInfo) {
  const prompt = `
Create a structured RECIPE object from the transcript. Be concise and faithful to the audio (no inventions).
Use null when unknown. If ingredients are implied, infer minimal sane entries.

SCHEMA:
{
  "type": "recipe",
  "title": string,
  "intro": string,                // short sentence on what dish it is
  "ingredients": string[],        // plain list
  "steps": [{"step": number, "instruction": string}], // numbered 1..N
  "notes": string[],              // tips/warnings/variations; can be []
  "category": "recipe"
}

Title: "${(videoInfo.title||'').replace(/"/g,'\\"')}"
TRANSCRIPT:
${firstChars(transcript, 8000)}
  `.trim();

  try {
    const { content } = await callOpenAIChat({
      model: LLM_MODEL,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON matching the schema.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1600
    });

    let obj = parseJsonFromContent(content, null);
    if (!obj || typeof obj !== 'object') obj = {};
    // Normalize
    obj.type = 'recipe';
    obj.category = 'recipe';
    obj.title = obj.title || (videoInfo.title || 'Recipe');
    obj.intro = obj.intro || '';
    obj.ingredients = Array.isArray(obj.ingredients) ? obj.ingredients : [];
    obj.steps = (Array.isArray(obj.steps) ? obj.steps : []).map((s, i) => ({
      step: Number(s?.step ?? i + 1),
      instruction: (s?.instruction || s?.action || String(s || '')).toString()
    })).filter(s => s.instruction);
    if (!obj.steps.length) obj.steps = [{ step: 1, instruction: 'No clear steps detected.' }];
    obj.notes = Array.isArray(obj.notes) ? obj.notes : [];
    return obj;
  } catch (e) {
    console.error('synthesizeRecipe error:', e?.message || e);
    return {
      type: 'recipe',
      category: 'recipe',
      title: videoInfo.title || 'Recipe',
      intro: '',
      ingredients: [],
      steps: [{ step: 1, instruction: 'Summary generation failed.' }],
      notes: []
    };
  }
}

async function synthesizeTutorial(transcript, videoInfo) {
  const prompt = `
Create a structured TUTORIAL object from the transcript. Be concise and faithful to the audio (no inventions).

SCHEMA:
{
  "type": "tutorial",
  "title": string,
  "intro": string,                 // what this tutorial covers
  "materials": string[],           // tools/requirements; can be []
  "steps": [{"step": number, "instruction": string}], // numbered 1..N
  "tips": string[],                // optional
  "warnings": string[],            // optional
  "category": "tutorial"
}

Title: "${(videoInfo.title||'').replace(/"/g,'\\"')}"
TRANSCRIPT:
${firstChars(transcript, 8000)}
  `.trim();

  try {
    const { content } = await callOpenAIChat({
      model: LLM_MODEL,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON matching the schema.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1600
    });

    let obj = parseJsonFromContent(content, null);
    if (!obj || typeof obj !== 'object') obj = {};
    // Normalize
    obj.type = 'tutorial';
    obj.category = 'tutorial';
    obj.title = obj.title || (videoInfo.title || 'Tutorial');
    obj.intro = obj.intro || '';
    obj.materials = Array.isArray(obj.materials) ? obj.materials : (Array.isArray(obj.materialsNeeded) ? obj.materialsNeeded : []);
    obj.steps = (Array.isArray(obj.steps) ? obj.steps : []).map((s, i) => ({
      step: Number(s?.step ?? i + 1),
      instruction: (s?.instruction || s?.title || String(s || '')).toString()
    })).filter(s => s.instruction);
    if (!obj.steps.length) obj.steps = [{ step: 1, instruction: 'No clear steps detected.' }];
    obj.tips = Array.isArray(obj.tips) ? obj.tips : [];
    obj.warnings = Array.isArray(obj.warnings) ? obj.warnings : [];
    return obj;
  } catch (e) {
    console.error('synthesizeTutorial error:', e?.message || e);
    return {
      type: 'tutorial',
      category: 'tutorial',
      title: videoInfo.title || 'Tutorial',
      intro: '',
      materials: [],
      steps: [{ step: 1, instruction: 'Summary generation failed.' }],
      tips: [],
      warnings: []
    };
  }
}


async function formatTranscript(verbatim) {
  if (!verbatim || typeof verbatim !== 'string') {
    return { verbatim: '', readable: '' };
  }
  try {
    const { content } = await callOpenAIChat({
      model: LLM_MODEL,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON.' },
        { role: 'user', content:
`Punctuate and paragraph the transcript into readable paragraphs without adding or removing content.
Return: {"readable": string}

TRANSCRIPT:
${firstChars(verbatim, 12000)}`
        }
      ],
      max_tokens: 800
    });
    const obj = parseJsonFromContent(content, { readable: verbatim });
    return { verbatim, readable: obj.readable || verbatim };
  } catch (e) {
    console.error('formatTranscript failed:', e?.message || e);
    return { verbatim, readable: verbatim };
  }
}

async function transcribeChunk(filePath) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath));
  formData.append('model', ASR_MODEL); // 'whisper-1'
  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...formData.getHeaders() },
    body: formData
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Whisper error ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  return json.text || '';
}

// --------------- Router + Schema-lite ---------------
function firstChars(t, n) {
  return (t || '').slice(0, n);
}

async function analyzeContentType(transcription, videoInfo) {
  const prompt = `
You are a routing model. Decide ONLY between: "recipe", "tutorial", or "story".
- "recipe": ingredients + cooking/prep context.
- "tutorial": how-to/guide (tools/requirements + steps) that is NOT cooking.
- "story": someone telling a story, opinions, narration without actionable steps.

Return strict JSON with keys:
{"contentType":"recipe|tutorial|story","confidence":0-1,"reason":"short reason"}

Title: "${(videoInfo.title||'').replace(/"/g,'\\"')}"
Snippet:
${firstChars(transcription, 1400)}
  `.trim();

  try {
    const { content } = await callOpenAIChat({
      model: LLM_MODEL,
      temperature: 0.0,
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON.' },
        { role: 'user', content: prompt }
      ]
    });
    const parsed = parseJsonFromContent(content, { contentType: 'story', confidence: 0.4, reason: 'fallback' });
    if (!parsed.contentType) parsed.contentType = 'story';
    return parsed;
  } catch (e) {
    console.error('analyzeContentType error:', e?.message || e);
    return { contentType: 'story', confidence: 0.0, reason: 'error-fallback' };
  }
}


// "Schema-lite" generator — no external libs needed, JSON-only
async function generateSpecializedSummary(transcription, videoInfo, analysis) {
  const typeRaw = (analysis?.contentType || 'story').toLowerCase();
  const type =
    typeRaw.includes('recipe')   ? 'recipe'   :
    typeRaw.includes('tutorial') ? 'tutorial' : 'story';

  try {
    if (type === 'story') {
      const t = await formatTranscript(transcription);
      return {
        type: 'story',
        category: 'general',
        title: videoInfo.title || 'Story',
        transcript: t
      };
    }
    if (type === 'recipe') {
      return await synthesizeRecipe(transcription, videoInfo);
    }
    // default: tutorial
    return await synthesizeTutorial(transcription, videoInfo);

  } catch (e) {
    console.error('generateSpecializedSummary error:', e?.message || e);
    // Ultime fallback (maar nog steeds zichtbaar/bruikbaar)
    return {
      type,
      category: type === 'tutorial' ? 'tutorial' : type === 'recipe' ? 'recipe' : 'general',
      title: videoInfo.title || 'Summary',
      steps: [{ step: 1, instruction: 'Summary failed. Please retry.' }]
    };
  }
}


// Normalize for UI robustness — avoids white screens
function normalizeForUI(summary, analysis) {
  const s = summary || {};
  const rawType = (analysis?.contentType || s.type || s.category || 'general').toLowerCase();
  const normType =
    rawType.includes('recipe')   ? 'recipe'   :
    rawType.includes('tutorial') ? 'tutorial' : 'general';

  s.type = s.type || normType;
  s.category = s.category || normType;

// in normalizeForUI(...) – extra guards
if (s.type === 'tutorial') {
  s.intro = typeof s.intro === 'string' ? s.intro : '';
  s.materials = Array.isArray(s.materials) ? s.materials : (Array.isArray(s.materialsNeeded) ? s.materialsNeeded : []);
}
if (s.type === 'recipe') {
  s.intro = typeof s.intro === 'string' ? s.intro : '';
  s.notes = Array.isArray(s.notes) ? s.notes : [];
}

  if (s.type === 'story' || s.category === 'general') {
    if (!s.transcript || typeof s.transcript !== 'object') {
      s.transcript = { verbatim: '', readable: '' };
    } else {
      s.transcript.verbatim = s.transcript.verbatim || '';
      s.transcript.readable = s.transcript.readable || '';
    }
    s.keyTakeaways = Array.isArray(s.keyTakeaways) ? s.keyTakeaways : [];
    s.quotes = Array.isArray(s.quotes) ? s.quotes : [];
  }
  return s;
}

// ---------------- Main endpoint ----------------
app.post('/process-video', async (req, res) => {
  const started = Date.now();
  const { summaryId, videoUrl, platform } = req.body || {};
  if (!summaryId || !videoUrl || !platform) {
    return res.status(400).json({ success: false, error: 'Missing summaryId | videoUrl | platform' });
  }

  try {
    await postProgress(summaryId, 'fetching_audio', 5, 'Resolving audio stream');
    const videoInfo = await extractVideoInfo(videoUrl);
    const wavPath = await downloadAndExtractAudio(videoUrl);

    await postProgress(summaryId, 'transcoding', 15, 'Ensuring size for ASR');
    const wavSmall = await compressIfNeeded(wavPath);

    await postProgress(summaryId, 'chunking', 20, 'Slicing audio into 60s parts');
    const chunks = await segmentAudio(wavSmall, 60);
    if (!chunks.length) throw new Error('No audio chunks produced');

    // Early transcript
    await postProgress(summaryId, 'transcribing', 30, 'Transcribing first chunks');
    const earlyN = Math.min(2, chunks.length);
    const earlyParts = await Promise.all(chunks.slice(0, earlyN).map(transcribeChunk));
    const earlyTranscript = earlyParts.join(' ').trim();
    await postProgress(summaryId, 'transcribing', 40, 'Early transcript ready', { transcript: earlyTranscript });

    // Route
    await postProgress(summaryId, 'classifying', 45);
    const analysis = await analyzeContentType(earlyTranscript, videoInfo);
    await postProgress(summaryId, 'classifying', 50, `Type: ${analysis.contentType}`);

    // Rest
    const restParts = await Promise.all(chunks.slice(earlyN).map(transcribeChunk));
    const fullTranscript = (earlyTranscript + ' ' + restParts.join(' ')).trim();
    await postProgress(summaryId, 'transcribed', 60, 'Full transcript ready', { transcript: fullTranscript });

    // Structure
    await postProgress(summaryId, 'structuring', 85);
    let summary = await generateSpecializedSummary(fullTranscript, videoInfo, analysis);
    summary = normalizeForUI(summary, analysis);

    await postProgress(summaryId, 'finalizing', 95);

    const processingMethod = 'audio-only+chunked';
    const wordCount = fullTranscript.trim().split(/\s+/).filter(Boolean).length;
    const data = { videoInfo, transcription: fullTranscript, summary, wordCount, processingMethod };

    return res.status(200).json({ success: true, data });
  } catch (e) {
    console.error('process-video failed:', e);
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log('Worker listening on :' + PORT));

module.exports = app;
