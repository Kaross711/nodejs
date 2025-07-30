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

// Generate summary using 2-step GPT-4o-mini processing
async function generateSummary(transcription, videoInfo, platform) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  try {
    // STEP 1: Analyze content type and key elements
    const analysisResult = await analyzeContentType(transcription, videoInfo, openaiApiKey);
    console.log('Content analysis:', analysisResult.contentType);

    // STEP 2: Generate specialized summary based on content type
    const specializedSummary = await generateSpecializedSummary(
      transcription, 
      videoInfo, 
      platform, 
      analysisResult, 
      openaiApiKey
    );

    return {
      ...specializedSummary,
      contentAnalysis: analysisResult // Include analysis for debugging
    };

  } catch (error) {
    console.error('Summary generation error:', error);
    throw new Error(`Failed to generate summary: ${error.message}`);
  }
}

// STEP 1: Analyze what type of content this is
async function analyzeContentType(transcription, videoInfo, openaiApiKey) {
  const analysisPrompt = `Analyze this video transcript and determine the content type and key elements.

Video Title: ${videoInfo.title}
Duration: ${videoInfo.duration ? Math.round(videoInfo.duration / 60) + ' minutes' : 'Unknown'}

Transcript:
${transcription}

Respond with JSON in this format:
{
  "contentType": "recipe|tutorial|tips|review|entertainment|news|educational|lifestyle|fitness|other",
  "subCategory": "specific subcategory (e.g. 'pasta recipe', 'productivity tips', 'phone review')",
  "keyElements": ["element1", "element2", "element3"],
  "targetAudience": "beginner|intermediate|advanced|general",
  "primaryFocus": "what is the main focus of this video",
  "hasSteps": true|false,
  "estimatedComplexity": "simple|moderate|complex"
}

Be accurate based on the actual content discussed.`;

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
          content: 'You are an expert content analyzer. Always respond with valid JSON only.'
        },
        {
          role: 'user', 
          content: analysisPrompt
        }
      ],
      max_tokens: 500,
      temperature: 0.2
    })
  });

  if (!response.ok) {
    throw new Error(`Content analysis failed: ${response.status}`);
  }

  const result = await response.json();
  
  try {
    return JSON.parse(result.choices[0].message.content);
  } catch (parseError) {
    // Fallback if parsing fails
    return {
      contentType: 'other',
      subCategory: 'general content',
      keyElements: ['video content'],
      targetAudience: 'general',
      primaryFocus: videoInfo.title || 'video content',
      hasSteps: false,
      estimatedComplexity: 'simple'
    };
  }
}

// STEP 2: Generate specialized summary based on content type
async function generateSpecializedSummary(transcription, videoInfo, platform, analysis, openaiApiKey) {
  let specializedPrompt = '';

  // Create specialized prompts based on content type
  switch (analysis.contentType) {
    case 'recipe':
      specializedPrompt = createRecipePrompt(transcription, videoInfo, analysis);
      break;
    case 'tutorial':
      specializedPrompt = createTutorialPrompt(transcription, videoInfo, analysis);
      break;
    case 'tips':
    case 'lifestyle':
      specializedPrompt = createTipsPrompt(transcription, videoInfo, analysis);
      break;
    case 'review':
      specializedPrompt = createReviewPrompt(transcription, videoInfo, analysis);
      break;
    case 'fitness':
      specializedPrompt = createFitnessPrompt(transcription, videoInfo, analysis);
      break;
    default:
      specializedPrompt = createGeneralPrompt(transcription, videoInfo, analysis);
  }

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
          content: `You are an expert at creating detailed, specialized summaries. Always respond with valid JSON only. Focus on being comprehensive and actionable.`
        },
        {
          role: 'user', 
          content: specializedPrompt
        }
      ],
      max_tokens: 2000,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    throw new Error(`Specialized summary failed: ${response.status}`);
  }

  const result = await response.json();
  
  try {
    return JSON.parse(result.choices[0].message.content);
  } catch (parseError) {
    console.error('Failed to parse specialized summary:', result.choices[0].message.content);
    // Return basic fallback
    return createFallbackSummary(videoInfo, analysis);
  }
}

// RECIPE-SPECIFIC PROMPT
function createRecipePrompt(transcription, videoInfo, analysis) {
  return `Create a detailed recipe summary from this cooking video.

Video Title: ${videoInfo.title}
Duration: ${videoInfo.duration ? Math.round(videoInfo.duration / 60) + ' minutes' : 'Unknown'}
Sub-category: ${analysis.subCategory}

Transcript:
${transcription}

Generate a comprehensive JSON response:
{
  "title": "Clear recipe name",
  "summary": "Brief description of the dish and cooking method",
  "servings": "number of servings or portions",
  "totalTime": "estimated total cooking time",
  "difficulty": "Easy|Medium|Hard",
  "ingredients": [
    {"item": "ingredient name", "amount": "quantity", "notes": "optional prep notes"}
  ],
  "equipment": ["pan", "oven", "etc"],
  "instructions": [
    {"step": 1, "action": "detailed instruction", "time": "duration if mentioned", "tips": "helpful tips"}
  ],
  "tips": ["cooking tip 1", "cooking tip 2"],
  "nutritionNotes": "any nutrition info mentioned",
  "variations": ["possible variations mentioned"],
  "category": "Recipe",
  "tags": ["cuisine-type", "meal-type", "dietary-restrictions"],
  "estimated_read_time": 5
}

Be very detailed and extract ALL ingredients and steps mentioned.`;
}

// TUTORIAL-SPECIFIC PROMPT  
function createTutorialPrompt(transcription, videoInfo, analysis) {
  return `Create a detailed tutorial summary from this instructional video.

Video Title: ${videoInfo.title}
Sub-category: ${analysis.subCategory}

Transcript:
${transcription}

Generate a comprehensive JSON response:
{
  "title": "Clear tutorial title",
  "summary": "What you'll learn and achieve",
  "difficulty": "Beginner|Intermediate|Advanced", 
  "timeRequired": "estimated time to complete",
  "materialsNeeded": [
    {"item": "material/tool name", "required": true|false, "alternatives": "if any"}
  ],
  "prerequisites": ["what you should know beforehand"],
  "steps": [
    {"step": 1, "title": "step title", "instruction": "detailed instruction", "timeEstimate": "time", "commonMistakes": "what to avoid", "successTips": "how to do it right"}
  ],
  "troubleshooting": [
    {"problem": "common issue", "solution": "how to fix"}
  ],
  "finalResult": "what you'll have accomplished",
  "nextSteps": ["what to do after completing this"],
  "category": "Tutorial", 
  "tags": ["skill-type", "tools-used"],
  "estimated_read_time": 6
}

Extract ALL detailed instructions and tips mentioned.`;
}

// TIPS/LIFESTYLE-SPECIFIC PROMPT
function createTipsPrompt(transcription, videoInfo, analysis) {
  return `Create a detailed tips summary from this advice/lifestyle video.

Video Title: ${videoInfo.title}
Sub-category: ${analysis.subCategory}

Transcript:
${transcription}

Generate a comprehensive JSON response:
{
  "title": "Clear title about the tips topic",
  "summary": "What area of life these tips improve",
  "targetArea": "productivity|health|relationships|finance|lifestyle|other",
  "tips": [
    {
      "tip": "clear tip title",
      "explanation": "detailed explanation of the tip",
      "whyItWorks": "scientific or logical reasoning",
      "howToImplement": "practical steps to apply this tip",
      "timeToSeeResults": "when to expect results",
      "difficulty": "Easy|Medium|Hard",
      "commonMistakes": "what people get wrong"
    }
  ],
  "implementationPlan": "suggested order or plan to apply these tips",
  "measuringSuccess": "how to track if tips are working",
  "relatedTopics": ["connected topics or areas"],
  "category": "Tips",
  "tags": ["life-area", "improvement-type"],
  "estimated_read_time": 4
}

Make each tip comprehensive with reasoning and implementation details.`;
}

// REVIEW-SPECIFIC PROMPT
function createReviewPrompt(transcription, videoInfo, analysis) {
  return `Create a detailed review summary from this product/service review video.

Video Title: ${videoInfo.title}
Sub-category: ${analysis.subCategory}

Transcript:
${transcription}

Generate a comprehensive JSON response:
{
  "title": "Product/Service Review Summary",
  "summary": "Overall impression and recommendation",
  "productName": "name of reviewed item",
  "category": "product category",
  "priceRange": "price mentioned or estimated range",
  "pros": ["positive aspect 1", "positive aspect 2"],
  "cons": ["negative aspect 1", "negative aspect 2"], 
  "keyFeatures": [
    {"feature": "feature name", "rating": "1-5", "explanation": "detailed thoughts"}
  ],
  "comparison": "how it compares to alternatives mentioned",
  "recommendation": "who should buy this and why",
  "verdict": "final recommendation with reasoning",
  "alternatives": ["other options mentioned"],
  "category": "Review",
  "tags": ["product-type", "brand"],
  "estimated_read_time": 4
}

Extract detailed opinions and specific comparisons mentioned.`;
}

// FITNESS-SPECIFIC PROMPT
function createFitnessPrompt(transcription, videoInfo, analysis) {
  return `Create a detailed fitness summary from this workout/health video.

Video Title: ${videoInfo.title}
Sub-category: ${analysis.subCategory}

Transcript:
${transcription}

Generate a comprehensive JSON response:
{
  "title": "Workout/Fitness Program Title", 
  "summary": "What this workout achieves",
  "workoutType": "strength|cardio|flexibility|mixed",
  "targetAreas": ["muscle groups or body areas targeted"],
  "duration": "workout length",
  "equipment": ["required equipment"],
  "exercises": [
    {"name": "exercise name", "sets": "number", "reps": "number", "duration": "time", "form": "proper form cues", "modifications": "easier/harder versions"}
  ],
  "warmUp": ["warm-up activities"],
  "coolDown": ["cool-down activities"],
  "safetyTips": ["important safety notes"],
  "progression": "how to make it harder over time",
  "frequency": "how often to do this workout",
  "category": "Fitness",
  "tags": ["workout-type", "fitness-level"],
  "estimated_read_time": 5
}

Extract all exercise details, form cues, and safety information.`;
}

// GENERAL/FALLBACK PROMPT
function createGeneralPrompt(transcription, videoInfo, analysis) {
  return `Create a detailed summary from this video content.

Video Title: ${videoInfo.title}
Content Type: ${analysis.contentType}
Sub-category: ${analysis.subCategory}

Transcript:
${transcription}

Generate a comprehensive JSON response:
{
  "title": "Clear, descriptive title",
  "summary": "Comprehensive overview of the content",
  "mainPoints": [
    {"point": "key point", "explanation": "detailed explanation", "importance": "why this matters"}
  ],
  "keyTakeaways": ["actionable takeaway 1", "actionable takeaway 2"],
  "targetAudience": "${analysis.targetAudience}",
  "actionableSteps": ["what viewer can do after watching"],
  "additionalResources": ["related topics or resources mentioned"],
  "category": "${analysis.contentType}",
  "tags": ["relevant", "tags", "based", "on", "content"],
  "estimated_read_time": 4
}

Focus on being comprehensive and actionable based on the actual content.`;
}

// Fallback summary if JSON parsing fails
function createFallbackSummary(videoInfo, analysis) {
  return {
    title: videoInfo.title || 'Video Summary',
    summary: `A ${analysis.contentType} video about ${analysis.subCategory}`,
    category: analysis.contentType,
    difficulty: analysis.estimatedComplexity,
    tags: [analysis.contentType, 'video'],
    estimated_read_time: 3
  };
}

app.listen(PORT, () => {
  console.log(`Video processing server running on port ${PORT}`);
  console.log('Health check: GET /health');
  console.log('Process video: POST /process-video');
});

module.exports = app;
