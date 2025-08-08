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
  const prompt = `You are a fast content router. Decide the type based on the snippet.
Title: "${(videoInfo.title||'').replace(/"/g,'\\"')}"
Snippet:
${firstChars(transcription, 1200)}

Return ONLY JSON like {"contentType":"recipe|tutorial|story"}`;
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LLM_MODEL, temperature: 0.1, messages: [{ role: 'system', content: 'Only JSON.' }, { role: 'user', content: prompt }] })
  });
  const data = await resp.json();
  try { return JSON.parse(data.choices[0].message.content); } catch { return { contentType: 'story' }; }
}

// "Schema-lite" generator — no external libs needed, JSON-only
async function generateSpecializedSummary(transcription, videoInfo, analysis) {
  const typeRaw = (analysis?.contentType || 'story').toLowerCase();
  const type =
    typeRaw.includes('recipe')   ? 'recipe'   :
    typeRaw.includes('tutorial') ? 'tutorial' : 'story';

  const SYSTEM = 'Return ONLY minified JSON. No commentary, no markdown, no backticks.';
  const baseMeta = `Meta: {"title":"${(videoInfo.title||'').replace(/"/g,'\\"')}","language":"auto"}`;

  let schema, task;
  if (type === 'recipe') {
    schema = `{"type":"recipe","title":string,"summary":string,"equipment":string[],"ingredients":[{"item":string,"amount":string|null,"notes":string|null}],"instructions":[{"step":number,"action":string,"time":string|null,"tips":string[]|null}],"tips":string[],"category":"recipe"}`;
    task = `Make a structured RECIPE from the transcript. Use null where unknown. Steps must have 'step' numbers.`;
  } else if (type === 'tutorial') {
    schema = `{"type":"tutorial","title":string,"summary":string,"difficulty":"Easy"|"Medium"|"Hard"|null,"timeRequired":string|null,"prerequisites":string[],"materialsNeeded":[{"item":string,"required":boolean,"function":string|null,"alternatives":string[]|null}],"steps":[{"step":number,"title":string|null,"instruction":string,"timeEstimate":string|null,"successTips":string[]|null,"commonMistakes":string[]|null}],"troubleshooting":[{"problem":string,"solution":string}],"nextSteps":string[],"resources":string[],"category":"tutorial"}`;
    task = `Make a structured TUTORIAL. Numbered 'steps' required. Keep fields concise; null when unknown.`;
  } else {
    schema = `{"type":"story","title":string,"summary":string,"transcript":{"verbatim":string,"readable":string},"keyTakeaways":string[],"quotes":string[],"category":"general"}`;
    task = `Make a STORY summary with both verbatim and readable transcript (punctuated paragraphs).`;
  }

  const prompt = `${task}
Schema: ${schema}
${baseMeta}
Transcript:
${firstChars(transcription, 8000)}`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.1,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
      max_tokens: 2000
    })
  });

  const data = await resp.json();
  const txt = data?.choices?.[0]?.message?.content || '';
  const first = txt.indexOf('{'), last = txt.lastIndexOf('}');
  const slice = first >= 0 && last > first ? txt.slice(first, last + 1) : txt;
  try { return JSON.parse(slice); }
  catch { return { type, title: videoInfo.title || 'Summary', summary: 'Parsing failed', category: type === 'tutorial' ? 'tutorial' : type === 'recipe' ? 'recipe' : 'general' }; }
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

  if (s.type === 'tutorial') {
    s.materialsNeeded = Array.isArray(s.materialsNeeded) ? s.materialsNeeded : [];
    s.steps = Array.isArray(s.steps) ? s.steps : [];
    s.troubleshooting = Array.isArray(s.troubleshooting) ? s.troubleshooting : [];
    s.nextSteps = Array.isArray(s.nextSteps) ? s.nextSteps : [];
    s.resources = Array.isArray(s.resources) ? s.resources : [];
  }
  if (s.type === 'recipe') {
    s.equipment = Array.isArray(s.equipment) ? s.equipment : [];
    s.ingredients = Array.isArray(s.ingredients) ? s.ingredients : [];
    s.instructions = Array.isArray(s.instructions) ? s.instructions : [];
    s.tips = Array.isArray(s.tips) ? s.tips : [];
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
