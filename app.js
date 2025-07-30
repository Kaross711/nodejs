// server.js - Railway Backend for Video Processing
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Video processing server is running' });
});

// Main video processing endpoint
app.post('/process-video', async (req, res) => {
  const { videoUrl, platform, summaryId } = req.body;

  if (!videoUrl || !platform) {
    return res.status(400).json({ 
      error: 'Missing required fields: videoUrl and platform' 
    });
  }

  console.log(`Processing ${platform} video: ${videoUrl}`);

  try {
    // Step 1: Extract video info
    const videoInfo = await extractVideoInfo(videoUrl);
    console.log('Video info extracted:', videoInfo.title);

    // Step 2: Download and extract audio
    const audioPath = await downloadAndExtractAudio(videoUrl);
    console.log('Audio extracted to:', audioPath);

    // Step 3: Transcribe with Whisper
    const transcription = await transcribeAudio(audioPath);
    console.log('Transcription completed, length:', transcription.length);

    // Step 4: Generate summary with GPT
    const summary = await generateSummary(transcription, videoInfo, platform);
    console.log('Summary generated');

    // Step 5: Cleanup temp files
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }

    res.json({
      success: true,
      data: {
        videoInfo,
        transcription,
        summary,
        wordCount: transcription.split(' ').length
      }
    });

  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Extract video info using yt-dlp
async function extractVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const command = `yt-dlp --no-download --print-json --no-warnings "${url}"`;
    
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        console.error('yt-dlp error:', stderr);
        reject(new Error(`Failed to extract video info: ${stderr}`));
        return;
      }

      try {
        const info = JSON.parse(stdout);
        resolve({
          title: info.title || 'Untitled Video',
          duration: info.duration || null,
          thumbnail: info.thumbnail || null,
          uploader: info.uploader || null,
          description: info.description || '',
          view_count: info.view_count || null,
          upload_date: info.upload_date || null
        });
      } catch (parseError) {
        reject(new Error('Failed to parse video info'));
      }
    });
  });
}

// Download video and extract audio
async function downloadAndExtractAudio(url) {
  return new Promise((resolve, reject) => {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }

    const timestamp = Date.now();
    const audioPath = path.join(tempDir, `audio_${timestamp}.wav`);
    
    // Use yt-dlp to download audio only
    const command = `yt-dlp -f "bestaudio/best" --extract-audio --audio-format wav --audio-quality 0 -o "${audioPath}" "${url}"`;
    
    exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) {
        console.error('Audio extraction error:', stderr);
        reject(new Error(`Failed to extract audio: ${stderr}`));
        return;
      }

      // yt-dlp changes the filename, find the actual file
      const actualAudioPath = audioPath.replace('.wav', '.wav');
      
      if (fs.existsSync(actualAudioPath)) {
        resolve(actualAudioPath);
      } else {
        // Try to find the file with different extension
        const files = fs.readdirSync(tempDir).filter(f => f.startsWith(`audio_${timestamp}`));
        if (files.length > 0) {
          resolve(path.join(tempDir, files[0]));
        } else {
          reject(new Error('Audio file not found after extraction'));
        }
      }
    });
  });
}

// Transcribe audio using OpenAI Whisper
async function transcribeAudio(audioPath) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioPath));
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whisper API error: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    return result.text;

  } catch (error) {
    console.error('Transcription error:', error);
    throw new Error(`Failed to transcribe audio: ${error.message}`);
  }
}

// Generate summary using GPT-4o-mini
async function generateSummary(transcription, videoInfo, platform) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  const prompt = `Create a structured tutorial summary from this ${platform} video transcript.

Video Title: ${videoInfo.title}
Platform: ${platform}
Duration: ${videoInfo.duration ? Math.round(videoInfo.duration / 60) + ' minutes' : 'Unknown'}
Uploader: ${videoInfo.uploader || 'Unknown'}

Transcript:
${transcription}

Generate a JSON response with this exact structure:
{
  "title": "Clear, descriptive title based on content",
  "summary": "Brief 2-3 sentence overview of the video content", 
  "key_points": ["Point 1", "Point 2", "Point 3"],
  "tutorial_steps": [
    {"step": 1, "title": "Step title", "description": "What to do", "timestamp": "0:30"},
    {"step": 2, "title": "Step title", "description": "What to do", "timestamp": "2:15"}
  ],
  "difficulty_level": "Beginner|Intermediate|Advanced",
  "category": "Education|Entertainment|Tutorial|Review|News|Other",
  "tags": ["tag1", "tag2", "tag3"],
  "estimated_read_time": 3
}

Focus on the actual content discussed. If it's not a tutorial, adapt the steps to key moments or topics. Be accurate to what was actually said.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an expert at creating structured tutorial summaries from video transcripts. Always respond with valid JSON only.'
          },
          {
            role: 'user', 
            content: prompt
          }
        ],
        max_tokens: 1500,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GPT API error: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    const summaryText = result.choices[0].message.content;

    // Parse JSON response
    try {
      return JSON.parse(summaryText);
    } catch (parseError) {
      console.error('Failed to parse GPT response:', summaryText);
      // Fallback
      return {
        title: videoInfo.title || `${platform} Video Summary`,
        summary: transcription.substring(0, 200) + '...',
        key_points: ['Content processed', 'Summary generated', 'Ready for review'],
        tutorial_steps: [],
        difficulty_level: 'Unknown',
        category: 'Other',
        tags: [platform.toLowerCase()],
        estimated_read_time: Math.ceil(transcription.split(' ').length / 200)
      };
    }

  } catch (error) {
    console.error('Summary generation error:', error);
    throw new Error(`Failed to generate summary: ${error.message}`);
  }
}

app.listen(PORT, () => {
  console.log(`Video processing server running on port ${PORT}`);
  console.log('Health check: GET /health');
  console.log('Process video: POST /process-video');
});

module.exports = app;
