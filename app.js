// app.js — Railway worker (CommonJS) with audio-only, chunked ASR, router-ish analysis, and progress callbacks.
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
if (!OPENAI_API_KEY) console.warn('[WARN] Missing OPENAI_API_KEY');
if (!EDGE_PROGRESS_URL) console.warn('[WARN] Missing EDGE_PROGRESS_URL');
if (!WORKER_TOKEN) console.warn('[WARN] Missing WORKER_TOKEN');

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

async function postProgress(summaryId, stage, percent, note, partial) {
  if (!EDGE_PROGRESS_URL || !WORKER_TOKEN) return;
  try {
    await fetch(EDGE_PROGRESS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-token': WORKER_TOKEN },
      body: JSON.stringify({ summaryId, stage, percent, note, partial })
    });
  } catch (e) { console.error('postProgress failed:', e.message || e); }
}

// ---------- Helpers from your existing code (with minor tweaks) ----------
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
  return new Promise((resolve, reject) => {
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
  // Returns a WAV path
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
        exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (err) => (err ? reject(err) : resolve()));
      });
      // Find produced file
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
  formData.append('model', 'whisper-1');
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

// Your existing analysis+summary (kept) ----------------------
async function analyzeContentType(transcription, videoInfo) {
  const prompt = `You are an expert content analyst. Analyze this video transcript and determine the content type.

Title: "${videoInfo.title}"
TRANSCRIPT (first 1200 chars):
${transcription.slice(0, 1200)}

Return JSON like: {"contentType":"recipe|tutorial|story|tips|review|fitness|other"}`;
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.1, messages: [{ role: 'system', content: 'Only JSON.' }, { role: 'user', content: prompt }] })
  });
  const data = await resp.json();
  try { return JSON.parse(data.choices[0].message.content); } catch { return { contentType: 'story' }; }
}

async function generateSpecializedSummary(transcription, videoInfo, analysis) {
  const prompt = `Make a helpful summary from this transcript. Keep it actionable. Return JSON.`;
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, messages: [{ role: 'system', content: 'Only JSON.' }, { role: 'user', content: prompt + '\n' + transcription.slice(0, 6000) }] })
  });
  const data = await resp.json();
  try { return JSON.parse(data.choices[0].message.content); } catch { return { title: videoInfo.title || 'Summary', summary: 'N/A' }; }
}

// ------------------------------------------------------------------------

app.post('/process-video', async (req, res) => {
  const { summaryId, videoUrl, platform } = req.body || {};
  if (!summaryId || !videoUrl || !platform) {
    return res.status(400).json({ success: false, error: 'Missing summaryId | videoUrl | platform' });
  }

  const started = Date.now();
  try {
    await postProgress(summaryId, 'fetching_audio', 5, 'Resolving audio stream');
    const videoInfo = await extractVideoInfo(videoUrl);
    const wavPath = await downloadAndExtractAudio(videoUrl);

    await postProgress(summaryId, 'transcoding', 15, 'Ensuring size for ASR');
    const wavSmall = await compressIfNeeded(wavPath);

    await postProgress(summaryId, 'chunking', 20, 'Slicing audio into 60s parts');
    const chunks = await segmentAudio(wavSmall, 60);
    if (!chunks.length) throw new Error('No audio chunks produced');

    // Early
    await postProgress(summaryId, 'transcribing', 30, 'Transcribing first chunks');
    const earlyN = Math.min(2, chunks.length);
    const earlyParts = await Promise.all(chunks.slice(0, earlyN).map(transcribeChunk));
    const earlyTranscript = earlyParts.join(' ').trim();
    await postProgress(summaryId, 'transcribing', 40, 'Early transcript ready', { transcript: earlyTranscript });

    // Route
    await postProgress(summaryId, 'classifying', 45);
    const initialAnalysis = await analyzeContentType(earlyTranscript, videoInfo);
    await postProgress(summaryId, 'classifying', 50, `Type: ${initialAnalysis.contentType}`);

    // Rest
    const restParts = await Promise.all(chunks.slice(earlyN).map(transcribeChunk));
    const fullTranscript = (earlyTranscript + ' ' + restParts.join(' ')).trim();
    await postProgress(summaryId, 'transcribed', 60, 'Full transcript ready', { transcript: fullTranscript });

    // Structure
    await postProgress(summaryId, 'structuring', 85);
    const summary = await generateSpecializedSummary(fullTranscript, videoInfo, initialAnalysis);

    await postProgress(summaryId, 'finalizing', 95);

    const processingMethod = 'audio-only+chunked';
    const wordCount = (fullTranscript.trim().split(/\s+/).filter(Boolean).length);

    return res.status(200).json({
      success: true,
      data: { videoInfo, transcription: fullTranscript, summary, wordCount, processingMethod }
    });
  } catch (e) {
    console.error('process-video failed:', e);
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log('Worker listening on :' + PORT));

module.exports = app;
