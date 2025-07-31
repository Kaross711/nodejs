// server.js - Complete Railway Backend met YouTube & Audio Fixes
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
  res.json({ status: 'OK', message: 'Bulletproof video processing server with YouTube fixes is running' });
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

    // Step 2: Download and extract audio with compression
    const audioPath = await downloadAndExtractAudio(videoUrl);
    console.log('Audio extracted to:', audioPath);

    // Step 3: Transcribe with Whisper (auto-detect language)
    const transcription = await transcribeAudio(audioPath);
    console.log('Transcription completed, length:', transcription.length);
    console.log('Transcription preview:', transcription.substring(0, 200) + '...');

    // Step 4: Initial content analysis
    console.log('Starting bulletproof AI processing...');
    const initialAnalysis = await analyzeContentType(transcription, videoInfo);
    console.log('Initial analysis:', initialAnalysis);
    
    // Step 5: BULLETPROOF PROCESSING - 3-layer system
    const summary = await generateSpecializedSummary(transcription, videoInfo, initialAnalysis);
    console.log('Bulletproof summary generated');

    // Step 6: Cleanup temp files
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }

    res.json({
      success: true,
      data: {
        videoInfo,
        transcription,
        summary,
        contentAnalysis: summary.contentAnalysis || initialAnalysis,
        wordCount: transcription.split(' ').length,
        processingMethod: summary.processingMethod || 'bulletproof'
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

// FIXED: Extract video info with YouTube fixes
async function extractVideoInfo(url) {
  // Detect platform from URL
  const platform = detectPlatformFromUrl(url);
  console.log('Detected platform for extraction:', platform);
  
  return new Promise((resolve, reject) => {
    let command;
    
    // Platform-specific commands
    switch (platform) {
      case 'instagram':
        command = `yt-dlp --no-download --print-json --no-warnings --user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15" "${url}"`;
        break;
      case 'tiktok':
        command = `yt-dlp --no-download --print-json --no-warnings --user-agent "Mozilla/5.0 (Linux; Android 10; SM-G973F)" "${url}"`;
        break;
      case 'twitter':
        command = `yt-dlp --no-download --print-json --no-warnings --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" "${url}"`;
        break;
      case 'youtube':
      default:
        command = `yt-dlp --no-download --print-json --no-warnings --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --extractor-args "youtube:player_client=android,web" "${url}"`;
        break;
    }
    
    console.log('Using extraction command for', platform);
    
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`${platform} extraction error:`, stderr);
        
        // Platform-specific error handling
        if (platform === 'instagram') {
          if (stderr.includes('Sign in to confirm') || stderr.includes('login required')) {
            reject(new Error('Instagram video is private or requires login. Please use a public Instagram video.'));
            return;
          }
          if (stderr.includes('Video unavailable')) {
            reject(new Error('Instagram video is unavailable or has been removed.'));
            return;
          }
        }
        
        // Generic fallback
        if (stderr.includes('Sign in to confirm') || stderr.includes('login required')) {
          reject(new Error(`${platform} video requires login or is age-restricted. Try a different video or make sure it's publicly accessible.`));
          return;
        }
        
        if (stderr.includes('Private video')) {
          reject(new Error(`This ${platform} video is private. Please use a public video.`));
          return;
        }
        
        if (stderr.includes('Video unavailable')) {
          reject(new Error(`${platform} video is unavailable or has been removed.`));
          return;
        }

        if (stderr.includes('Requested format is not available')) {
          console.log(`Retrying ${platform} with fallback method...`);
          return extractVideoInfoFallback(url, platform).then(resolve).catch(reject);
        }
        
        reject(new Error(`Failed to extract ${platform} video info: ${stderr}`));
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
        console.error('Parse error, trying fallback...');
        extractVideoInfoFallback(url, platform).then(resolve).catch(reject);
      }
    });
  });
}


function detectPlatformFromUrl(url) {
  const urlLower = url.toLowerCase();
  
  if (urlLower.includes('instagram.com')) return 'instagram';
  if (urlLower.includes('tiktok.com')) return 'tiktok';
  if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) return 'twitter';
  if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) return 'youtube';
  
  return 'unknown';
}

// UPDATED: Fallback method with platform awareness
async function extractVideoInfoFallback(url, platform = 'unknown') {
  return new Promise((resolve, reject) => {
    // Ultra-simple approach - just get basic info
    const command = `yt-dlp --no-download --get-title --get-duration --get-thumbnail --no-warnings "${url}"`;
    
    exec(command, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Fallback extraction failed for ${platform}: ${stderr}`));
        return;
      }

      const lines = stdout.trim().split('\n');
      resolve({
        title: lines[0] || `${platform} Video`,
        duration: null,
        thumbnail: lines[2] || null,
        uploader: platform,
        description: '',
        view_count: null,
        upload_date: null
      });
    });
  });
}

// FIXED: Download and extract audio with compression strategies
async function downloadAndExtractAudio(url) {
  const platform = detectPlatformFromUrl(url);
  console.log('Detected platform for audio extraction:', platform);
  
  return new Promise((resolve, reject) => {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }

    const timestamp = Date.now();
    const audioPath = path.join(tempDir, `audio_${timestamp}`);
    
    // Enhanced Instagram-specific extraction strategies
    let extractionStrategies;
    
    switch (platform) {
      case 'instagram':
        extractionStrategies = [
          // Strategy 1: Modern Instagram mobile
          {
            name: 'instagram-mobile-latest',
            command: `yt-dlp -f "best[ext=mp4]" --extract-audio --audio-format wav --user-agent "Instagram 219.0.0.12.117 Android" --add-header "Accept:*/*" --add-header "Accept-Language:en-US,en;q=0.5" -o "${audioPath}.%(ext)s" "${url}"`
          },
          // Strategy 2: Instagram web browser
          {
            name: 'instagram-web',
            command: `yt-dlp -f "best" --extract-audio --audio-format wav --user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15" --add-header "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" -o "${audioPath}.%(ext)s" "${url}"`
          },
          // Strategy 3: Simple Instagram extraction
          {
            name: 'instagram-simple',
            command: `yt-dlp --extract-audio --audio-format wav --no-check-certificate --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" -o "${audioPath}.%(ext)s" "${url}"`
          },
          // Strategy 4: Instagram with cookies (if available)
          {
            name: 'instagram-fallback',
            command: `yt-dlp -f "worst" --extract-audio --audio-format wav --audio-quality 5 --ignore-errors -o "${audioPath}.%(ext)s" "${url}"`
          },
          // Strategy 5: Ultra-basic extraction
          {
            name: 'instagram-ultra-basic',
            command: `yt-dlp --extract-audio --audio-format wav --ignore-config --no-warnings --ignore-errors -o "${audioPath}.%(ext)s" "${url}"`
          }
        ];
        break;
        
      case 'tiktok':
        extractionStrategies = [
          {
            name: 'tiktok-mobile',
            command: `yt-dlp -f "best" --extract-audio --audio-format wav --user-agent "Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36" -o "${audioPath}.%(ext)s" "${url}"`
          },
          {
            name: 'tiktok-simple',
            command: `yt-dlp --extract-audio --audio-format wav --ignore-errors -o "${audioPath}.%(ext)s" "${url}"`
          }
        ];
        break;
        
      case 'twitter':
        extractionStrategies = [
          {
            name: 'twitter-best',
            command: `yt-dlp -f "best" --extract-audio --audio-format wav --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -o "${audioPath}.%(ext)s" "${url}"`
          },
          {
            name: 'twitter-simple',
            command: `yt-dlp --extract-audio --audio-format wav --ignore-errors -o "${audioPath}.%(ext)s" "${url}"`
          }
        ];
        break;
        
      case 'youtube':
      default:
        extractionStrategies = [
          {
            name: 'youtube-android',
            command: `yt-dlp -f "bestaudio[filesize<20M]/best[filesize<20M]" --extract-audio --audio-format wav --audio-quality 0 --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" --extractor-args "youtube:player_client=android" -o "${audioPath}.%(ext)s" "${url}"`
          },
          {
            name: 'youtube-mobile',
            command: `yt-dlp -f "bestaudio/best" --extract-audio --audio-format wav --audio-quality 2 --user-agent "Mozilla/5.0 (Linux; Android 10)" --extractor-args "youtube:player_client=android" -o "${audioPath}.%(ext)s" "${url}"`
          },
          {
            name: 'youtube-simple',
            command: `yt-dlp --extract-audio --audio-format wav --ignore-errors -o "${audioPath}.%(ext)s" "${url}"`
          }
        ];
        break;
    }

    async function tryStrategy(strategyIndex = 0) {
      if (strategyIndex >= extractionStrategies.length) {
        // SPECIAL: For Instagram, try one more desperate attempt
        if (platform === 'instagram') {
          console.log('Trying Instagram desperate fallback...');
          return tryInstagramFallback(url, audioPath, timestamp).then(resolve).catch(() => {
            reject(new Error(`All ${platform} audio extraction strategies failed. Instagram videos are often restricted. Try a different Instagram video or use a video from YouTube/TikTok instead.`));
          });
        }
        
        reject(new Error(`All ${platform} audio extraction strategies failed. This ${platform} video might not be downloadable.`));
        return;
      }

      const strategy = extractionStrategies[strategyIndex];
      console.log(`Trying ${platform} extraction strategy ${strategyIndex + 1}/${extractionStrategies.length}: ${strategy.name}`);

      exec(strategy.command, { 
        maxBuffer: 1024 * 1024 * 50,
        timeout: 60000 // 60 second timeout
      }, async (error, stdout, stderr) => {
        if (error) {
          console.error(`${platform} strategy ${strategy.name} failed:`, stderr.substring(0, 500));
          
          // Instagram-specific error handling
          if (platform === 'instagram') {
            if (stderr.includes('This content isn\'t available right now') || 
                stderr.includes('The link you followed may be broken') ||
                stderr.includes('Sorry, this page isn\'t available')) {
              console.log('Instagram content not available, trying next strategy...');
              return tryStrategy(strategyIndex + 1);
            }
          }
          
          // Generic error handling
          if (stderr.includes('Requested format is not available') || 
              stderr.includes('No video formats found') ||
              stderr.includes('Unable to extract') ||
              stderr.includes('HTTP Error 403') ||
              stderr.includes('HTTP Error 404')) {
            console.log(`${platform} strategy failed, trying next...`);
            return tryStrategy(strategyIndex + 1);
          }
          
          // For other errors, also try next strategy
          return tryStrategy(strategyIndex + 1);
        }

        try {
          // Find the extracted audio file
          const files = fs.readdirSync(tempDir).filter(f => f.startsWith(`audio_${timestamp}`));
          
          if (files.length === 0) {
            console.log(`No files found for ${platform} strategy ${strategy.name}, trying next...`);
            return tryStrategy(strategyIndex + 1);
          }

          const extractedFile = path.join(tempDir, files[0]);
          
          if (!fs.existsSync(extractedFile)) {
            console.log(`${platform} file doesn't exist, trying next strategy...`);
            return tryStrategy(strategyIndex + 1);
          }

          const fileStats = fs.statSync(extractedFile);
          const fileSizeMB = fileStats.size / (1024 * 1024);

          console.log(`✅ Extracted ${platform} audio: ${files[0]}, size: ${fileSizeMB.toFixed(2)}MB`);

          // Check if file is valid (not too small)
          if (fileSizeMB < 0.01) {
            console.log(`${platform} file too small (${fileSizeMB.toFixed(3)}MB), probably empty. Trying next strategy...`);
            // Clean up empty file
            fs.unlinkSync(extractedFile);
            return tryStrategy(strategyIndex + 1);
          }

          // Check if file is under Whisper's 25MB limit
          if (fileSizeMB > 24) {
            console.log(`${platform} file too large (${fileSizeMB.toFixed(2)}MB), trying compression...`);
            
            const compressedPath = await compressAudio(extractedFile, timestamp);
            if (compressedPath) {
              resolve(compressedPath);
            } else {
              console.log(`${platform} compression failed, trying next extraction strategy...`);
              return tryStrategy(strategyIndex + 1);
            }
          } else {
            resolve(extractedFile);
          }

        } catch (fileError) {
          console.error(`${platform} file processing error for strategy ${strategy.name}:`, fileError);
          return tryStrategy(strategyIndex + 1);
        }
      });
    }

    // Start with first strategy
    tryStrategy(0);
  });
}

// NEW: Instagram desperate fallback
async function tryInstagramFallback(url, audioPath, timestamp) {
  return new Promise((resolve, reject) => {
    console.log('Trying Instagram desperate fallback method...');
    
    // Try to download video first, then extract audio with ffmpeg
    const videoPath = audioPath.replace('audio_', 'video_') + '.mp4';
    const command = `yt-dlp -f "best[height<=480]" --no-check-certificate --ignore-errors --user-agent "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" -o "${videoPath}" "${url}" && ffmpeg -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}_fallback.wav"`;
    
    exec(command, { 
      maxBuffer: 1024 * 1024 * 100,
      timeout: 120000 // 2 minute timeout
    }, (error, stdout, stderr) => {
      // Clean up video file if it exists
      if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
      }
      
      if (error) {
        console.error('Instagram fallback failed:', stderr.substring(0, 300));
        reject(new Error('Instagram fallback extraction failed'));
        return;
      }
      
      const fallbackAudioPath = `${audioPath}_fallback.wav`;
      if (fs.existsSync(fallbackAudioPath)) {
        const fileStats = fs.statSync(fallbackAudioPath);
        const fileSizeMB = fileStats.size / (1024 * 1024);
        
        if (fileSizeMB > 0.01) {
          console.log(`✅ Instagram fallback successful: ${fileSizeMB.toFixed(2)}MB`);
          resolve(fallbackAudioPath);
        } else {
          reject(new Error('Instagram fallback produced empty file'));
        }
      } else {
        reject(new Error('Instagram fallback file not found'));
      }
    });
  });
}

// NEW: Additional compression function
async function compressAudio(inputPath, timestamp) {
  return new Promise((resolve) => {
    const outputPath = inputPath.replace(/\.[^.]+$/, '_compressed.wav');
    
    // Aggressive compression: mono, 16kHz, lower bitrate
    const compressionCommand = `ffmpeg -i "${inputPath}" -ac 1 -ar 16000 -b:a 32k "${outputPath}"`;
    
    exec(compressionCommand, (error, stdout, stderr) => {
      if (error) {
        console.error('Compression failed:', stderr);
        resolve(null);
        return;
      }

      try {
        const fileStats = fs.statSync(outputPath);
        const fileSizeMB = fileStats.size / (1024 * 1024);
        
        console.log(`Compressed audio size: ${fileSizeMB.toFixed(2)}MB`);
        
        if (fileSizeMB < 24) {
          // Clean up original file
          fs.unlinkSync(inputPath);
          resolve(outputPath);
        } else {
          console.log('Compression still too large');
          resolve(null);
        }
      } catch (err) {
        console.error('Compression check failed:', err);
        resolve(null);
      }
    });
  });
}

// UPDATED: Transcribe with better error handling
async function transcribeAudio(audioPath) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  // Pre-check file size
  const fileStats = fs.statSync(audioPath);
  const fileSizeMB = fileStats.size / (1024 * 1024);
  
  console.log(`Transcribing audio file: ${fileSizeMB.toFixed(2)}MB`);
  
  if (fileSizeMB > 24) {
    throw new Error(`Audio file too large for Whisper API: ${fileSizeMB.toFixed(2)}MB (max 25MB)`);
  }

  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioPath));
    formData.append('model', 'whisper-1');
    // AUTO-DETECT LANGUAGE - no language parameter

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
      
      // Handle specific 413 error
      if (response.status === 413) {
        throw new Error(`Audio file too large for Whisper API. Try a shorter video or lower quality source.`);
      }
      
      throw new Error(`Whisper API error: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    return result.text;

  } catch (error) {
    console.error('Transcription error:', error);
    throw new Error(`Failed to transcribe audio: ${error.message}`);
  }
}

// Initial content analysis
async function analyzeContentType(transcription, videoInfo) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  const analysisPrompt = `You are an expert content analyst. Analyze this video transcript and determine the content type.

Video Title: "${videoInfo.title}"
Duration: ${videoInfo.duration ? Math.round(videoInfo.duration / 60) + ' minutes' : 'Unknown'}

TRANSCRIPT:
${transcription}

Analyze the ACTUAL CONTENT and respond with JSON:
{
  "contentType": "recipe|tutorial|tips|review|fitness|business|educational|story|tech|other",
  "subCategory": "specific_description",
  "keyElements": ["element1", "element2", "element3"],
  "targetAudience": "beginner|intermediate|advanced|general",
  "primaryFocus": "main_focus",
  "hasActionableSteps": true|false,
  "estimatedComplexity": "simple|moderate|complex",
  "language": "detected_language",
  "mainTopics": ["topic1", "topic2"]
}`;

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
            content: 'You are an expert multilingual content analyzer. Always respond with valid JSON only.'
          },
          {
            role: 'user', 
            content: analysisPrompt
          }
        ],
        max_tokens: 500,
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`Content analysis failed: ${response.status}`);
    }

    const result = await response.json();
    
    try {
      const analysis = JSON.parse(result.choices[0].message.content);
      return analysis;
    } catch (parseError) {
      console.error('Failed to parse analysis JSON');
      return {
        contentType: 'other',
        subCategory: 'general content',
        keyElements: ['video content'],
        targetAudience: 'general',
        primaryFocus: videoInfo.title || 'video content',
        hasActionableSteps: false,
        estimatedComplexity: 'simple',
        language: 'unknown',
        mainTopics: ['general']
      };
    }
  } catch (error) {
    console.error('Analysis error:', error);
    throw error;
  }
}

// BULLETPROOF SPECIALIZED SUMMARY GENERATION
async function generateSpecializedSummary(transcription, videoInfo, analysis) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  console.log('Starting bulletproof processing for:', analysis.contentType);

  try {
    // STEP 1: Enhanced Content Re-Analysis with Better Context
    const enhancedAnalysis = await deepContentAnalysis(transcription, videoInfo, analysis, openaiApiKey);
    console.log('Enhanced analysis:', enhancedAnalysis);

    // STEP 2: Generate Comprehensive Summary using Enhanced Context
    const comprehensiveSummary = await generateBulletproofSummary(transcription, videoInfo, enhancedAnalysis, openaiApiKey);
    console.log('Comprehensive summary generated');

    // STEP 3: Quality Check & Enhancement
    const finalSummary = await enhanceAndValidateSummary(comprehensiveSummary, enhancedAnalysis, openaiApiKey);
    
    return {
      ...finalSummary,
      contentAnalysis: enhancedAnalysis,
      processingMethod: 'bulletproof'
    };

  } catch (error) {
    console.error('Bulletproof processing failed, using fallback:', error);
    return await generateFallbackSummary(transcription, videoInfo, analysis, openaiApiKey);
  }
}

// STEP 1: Deep Content Analysis - Verstaat ALLES
async function deepContentAnalysis(transcription, videoInfo, initialAnalysis, openaiApiKey) {
  const deepAnalysisPrompt = `You are the world's most advanced content analyst. Analyze this video transcript with extreme precision and understanding.

CONTEXT:
Video Title: "${videoInfo.title}"
Duration: ${videoInfo.duration ? Math.round(videoInfo.duration / 60) + ' minutes' : 'Unknown'}
Initial Analysis: ${JSON.stringify(initialAnalysis)}

COMPLETE TRANSCRIPT:
${transcription}

ANALYSIS INSTRUCTIONS:
1. LANGUAGE DETECTION: Identify exact language (Dutch, English, mix)
2. CULTURAL CONTEXT: Understand regional terms, slang, colloquialisms
3. TOOL/WEBSITE RECOGNITION: Extract exact names mentioned, even if mispronounced
4. CONTENT INTENT: What is the creator really trying to teach/share?
5. AUDIENCE ANALYSIS: Who is this content for? 
6. ACTION ITEMS: What specific actions should viewers take?
7. VALUE PROPOSITION: What problem does this solve?

ADVANCED RECOGNITION:
- Dutch marketing terms: "effectief", "optimalisatie", "strategie", "tools", "gratis", "betaald"
- Tool name variations: "ChatGPT" = "Chat GPT", "Chattypt", "Chat-gpt"
- Website phonetics: "Kwetter" might be "Twitter", unclear audio = describe function
- Business concepts: SEO, conversion, engagement, traffic, ranking

Respond with enhanced JSON:
{
  "contentType": "most_accurate_primary_type",
  "secondaryType": "alternative_classification_if_hybrid",
  "subCategory": "ultra_specific_description", 
  "exactLanguage": "primary_language_detected",
  "culturalContext": "regional_or_platform_specific_context",
  "primaryIntent": "what_creator_wants_to_achieve",
  "audienceLevel": "beginner|intermediate|advanced|mixed",
  "toolsMentioned": [
    {
      "heardAs": "exact_audio_as_heard", 
      "likelyActual": "probable_real_name",
      "function": "what_this_tool_does",
      "confidence": "high|medium|low"
    }
  ],
  "keyTopics": ["all_main_subjects_discussed"],
  "actionableElements": ["concrete_things_viewers_can_do"],
  "complexityFactors": ["what_makes_this_content_challenging"],
  "structureType": "how_this_should_be_organized",
  "missingElements": ["what_info_might_be_unclear_or_missing"],
  "contextClues": ["additional_hints_about_content"]
}

Be extremely thorough and understanding. Recognize that speakers may:
- Mispronounce tool names
- Mix languages 
- Use regional slang
- Speak unclearly on certain words
- Reference tools without full context`;

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
          content: 'You are an expert multilingual content analyst with deep understanding of digital marketing, technology, and cultural nuances. You excel at extracting meaning from unclear audio and mixed-language content.'
        },
        {
          role: 'user', 
          content: deepAnalysisPrompt
        }
      ],
      max_tokens: 800,
      temperature: 0.1
    })
  });

  if (!response.ok) {
    throw new Error(`Deep analysis failed: ${response.status}`);
  }

  const result = await response.json();
  
  try {
    return JSON.parse(result.choices[0].message.content);
  } catch (parseError) {
    console.error('Failed to parse deep analysis:', result.choices[0].message.content);
    return initialAnalysis; // Fallback to original
  }
}

// STEP 2: Bulletproof Summary Generation
async function generateBulletproofSummary(transcription, videoInfo, enhancedAnalysis, openaiApiKey) {
  const bulletproofPrompt = `Create the most comprehensive, actionable summary possible for this ${enhancedAnalysis.exactLanguage} video about ${enhancedAnalysis.subCategory}.

ENHANCED CONTEXT:
${JSON.stringify(enhancedAnalysis, null, 2)}

VIDEO DETAILS:
Title: "${videoInfo.title}"
Duration: ${videoInfo.duration ? Math.round(videoInfo.duration / 60) + ' minutes' : 'Unknown'}

COMPLETE TRANSCRIPT:
${transcription}

BULLETPROOF PROCESSING RULES:
1. EXTRACT EVERYTHING: Every tool, step, tip, warning, example mentioned
2. CLARIFY UNCLEAR ELEMENTS: If tool name is unclear, describe its function
3. LOGICAL STRUCTURE: Organize content in the most logical, actionable way
4. FILL GAPS: Use industry knowledge to complete incomplete information
5. PRACTICAL FOCUS: Make everything immediately actionable
6. ERROR CORRECTION: Fix obvious misspellings/mishearings based on context

CREATE ADAPTIVE STRUCTURE based on content type:

FOR BUSINESS/MARKETING CONTENT:
{
  "title": "Clear actionable title in English",
  "summary": "What business goal this achieves and why it matters",
  "targetOutcome": "specific result viewers will achieve",
  "difficulty": "Beginner|Intermediate|Advanced",
  "timeToImplement": "realistic time estimate",
  "requiredTools": [
    {
      "toolName": "best_guess_at_actual_name (heard as: 'audio_version')",
      "function": "what_this_tool_does_specifically", 
      "cost": "Free|Paid|Freemium|Unknown",
      "alternatives": "similar_tools_that_do_same_thing",
      "criticalness": "Essential|Helpful|Optional"
    }
  ],
  "implementationSteps": [
    {
      "phase": "logical_phase_name",
      "objective": "what_this_phase_accomplishes",
      "actions": [
        {
          "action": "specific_actionable_step",
          "details": "exactly_how_to_do_this",
          "tools": ["tools_needed_for_this_step"],
          "timeEstimate": "how_long_this_takes",
          "successMetrics": "how_to_know_you_did_it_right",
          "commonIssues": "what_typically_goes_wrong",
          "troubleshooting": "how_to_fix_problems"
        }
      ]
    }
  ],
  "strategicContext": {
    "whyThisMatters": "business_importance",
    "whenToUse": "optimal_timing_or_situations", 
    "targetAudience": "who_should_do_this",
    "expectedResults": "what_outcomes_to_expect",
    "advancedTips": ["expert_level_optimizations"]
  },
  "qualityChecklist": ["how_to_verify_success"],
  "nextSteps": ["what_to_do_after_completing_this"],
  "resources": ["additional_learning_materials"],
  "category": "${enhancedAnalysis.contentType}",
  "tags": ["${enhancedAnalysis.keyTopics?.join('", "')}"],
  "estimated_read_time": 8
}

FOR TUTORIAL CONTENT:
{
  "title": "Step-by-step guide title",
  "objective": "what_you_will_build_or_learn",
  "difficulty": "Beginner|Intermediate|Advanced",
  "totalTime": "complete_time_estimate",
  "prerequisites": ["required_knowledge_or_setup"],
  "materialsAndTools": [
    {
      "item": "exact_item_needed",
      "purpose": "why_you_need_this",
      "where_to_get": "source_or_alternative",
      "cost": "price_range_if_mentioned"
    }
  ],
  "detailedSteps": [
    {
      "stepNumber": 1,
      "title": "descriptive_step_name",
      "objective": "what_this_step_accomplishes",
      "instructions": "detailed_how_to_instructions",
      "duration": "time_for_this_step",
      "tools": ["specific_tools_for_this_step"],
      "visualCues": "what_you_should_see",
      "qualityCheck": "how_to_verify_correct_completion",
      "troubleshooting": [
        {
          "problem": "common_issue",
          "solution": "how_to_fix",
          "prevention": "how_to_avoid"
        }
      ],
      "tips": ["optimization_advice"],
      "warnings": ["important_safety_or_caution_notes"]
    }
  ],
  "finalValidation": "how_to_test_final_result",
  "variations": ["different_approaches_or_modifications"],
  "maintenance": "ongoing_care_or_updates_needed",
  "category": "Tutorial",
  "estimated_read_time": 10
}

FOR TIPS/ADVICE CONTENT:
{
  "title": "Comprehensive advice guide",
  "focus": "main_improvement_area", 
  "applicability": "who_this_helps_most",
  "tips": [
    {
      "tip": "clear_tip_name",
      "description": "what_this_tip_involves",
      "implementation": {
        "immediate_actions": ["things_to_do_right_now"],
        "setup_required": ["one_time_preparations"], 
        "ongoing_habits": ["behaviors_to_maintain"]
      },
      "science": "why_this_works_psychologically_or_technically",
      "difficulty": "Easy|Medium|Hard",
      "timeInvestment": "how_much_time_this_requires",
      "expectedResults": {
        "immediate": "what_happens_right_away",
        "short_term": "results_within_days_or_weeks", 
        "long_term": "lasting_benefits"
      },
      "measurements": "how_to_track_progress",
      "troubleshooting": "what_to_do_if_it_doesnt_work",
      "advanced": "ways_to_optimize_further"
    }
  ],
  "implementation_strategy": "best_order_to_try_these_tips",
  "success_indicators": "how_to_know_its_working",
  "category": "Tips",
  "estimated_read_time": 6
}

CRITICAL INSTRUCTIONS:
- If transcript is unclear, use context clues and industry knowledge
- For unclear tool names, provide best guess + function description
- Make every element actionable and specific
- Include realistic time estimates based on content complexity
- Add troubleshooting for predictable problems
- Structure for immediate usability

Translate Dutch content to English but preserve specific tool/brand names as heard.`;

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
          content: 'You are an expert content processor who creates the most comprehensive, actionable summaries possible. You understand business, technical, and practical content across multiple languages and can fill in gaps with industry expertise.'
        },
        {
          role: 'user', 
          content: bulletproofPrompt
        }
      ],
      max_tokens: 3500,
      temperature: 0.2
    })
  });

  if (!response.ok) {
    throw new Error(`Bulletproof summary failed: ${response.status}`);
  }

  const result = await response.json();
  
  try {
    return JSON.parse(result.choices[0].message.content);
  } catch (parseError) {
    console.error('Failed to parse bulletproof summary:', result.choices[0].message.content);
    throw new Error('Summary parsing failed');
  }
}

// STEP 3: Quality Enhancement & Validation
async function enhanceAndValidateSummary(summary, analysis, openaiApiKey) {
  const enhancementPrompt = `Review and enhance this summary for maximum clarity and completeness.

ORIGINAL ANALYSIS:
${JSON.stringify(analysis, null, 2)}

GENERATED SUMMARY:
${JSON.stringify(summary, null, 2)}

ENHANCEMENT TASKS:
1. COMPLETENESS CHECK: Are all mentioned elements included?
2. CLARITY IMPROVEMENT: Can instructions be clearer?
3. TOOL VERIFICATION: Do tool names make sense in context?
4. LOGICAL FLOW: Is the structure optimal for users?
5. PRACTICAL VALIDATION: Are time estimates realistic?
6. GAP FILLING: Add any missing critical information

Return the enhanced summary in the same JSON format, but improved:
- Clearer instructions
- Better tool name guesses based on function
- More realistic estimates  
- Additional helpful context
- Improved organization

Only return the JSON, no other text.`;

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
          content: 'You are a quality assurance specialist who perfects content summaries for maximum user value.'
        },
        {
          role: 'user', 
          content: enhancementPrompt
        }
      ],
      max_tokens: 2000,
      temperature: 0.1
    })
  });

  if (!response.ok) {
    console.error('Enhancement failed, returning original summary');
    return summary;
  }

  const result = await response.json();
  
  try {
    const enhanced = JSON.parse(result.choices[0].message.content);
    console.log('Summary enhanced successfully');
    return enhanced;
  } catch (parseError) {
    console.error('Enhancement parsing failed, returning original');
    return summary;
  }
}

// FALLBACK: Last resort comprehensive summary
async function generateFallbackSummary(transcription, videoInfo, analysis, openaiApiKey) {
  console.log('Using fallback summary generation');
  
  const fallbackPrompt = `Extract maximum value from this video transcript, even if some elements are unclear.

Video: "${videoInfo.title}"
Type: ${analysis.contentType}

TRANSCRIPT:
${transcription}

Create the most helpful summary possible:
{
  "title": "Descriptive title based on content",
  "summary": "What this content covers and its value",
  "keyPoints": [
    {"point": "main_topic", "details": "explanation", "action": "what_to_do"}
  ],
  "toolsOrResources": [
    {"name": "tool_or_resource_mentioned", "purpose": "what_its_for"}
  ],
  "actionableSteps": ["things_viewer_can_actually_do"],
  "importantNotes": ["key_warnings_or_tips"],
  "category": "${analysis.contentType}",
  "estimated_read_time": 5
}

Focus on practical value even if some details are unclear.`;

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
            role: 'user', 
            content: fallbackPrompt
          }
        ],
        max_tokens: 1500,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      throw new Error('Fallback also failed');
    }

    const result = await response.json();
    return JSON.parse(result.choices[0].message.content);
    
  } catch (error) {
    console.error('All processing failed:', error);
    return {
      title: videoInfo.title || 'Video Summary',
      summary: 'Content processing encountered difficulties',
      category: analysis.contentType,
      processingNote: 'This video required manual review',
      estimated_read_time: 3
    };
  }
}

app.listen(PORT, () => {
  console.log(`Bulletproof video processing server with YouTube fixes running on port ${PORT}`);
  console.log('Health check: GET /health');
  console.log('Process video: POST /process-video');
});

module.exports = app;
