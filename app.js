// server.js - Verbeterde Railway Backend voor Video Processing
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

    // Step 4: NEW 3-STEP AI PROCESS
    console.log('Starting 3-step AI processing...');
    
    // STEP 4A: Analyze content type
    const contentAnalysis = await analyzeContentType(transcription, videoInfo);
    console.log('Content analysis:', contentAnalysis);
    
    // STEP 4B: Generate specialized summary
    const summary = await generateSpecializedSummary(transcription, videoInfo, contentAnalysis);
    console.log('Specialized summary generated');

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
        contentAnalysis, // Include analysis for debugging
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
    
    const command = `yt-dlp -f "bestaudio/best" --extract-audio --audio-format wav --audio-quality 0 -o "${audioPath}" "${url}"`;
    
    exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) {
        console.error('Audio extraction error:', stderr);
        reject(new Error(`Failed to extract audio: ${stderr}`));
        return;
      }

      const actualAudioPath = audioPath.replace('.wav', '.wav');
      
      if (fs.existsSync(actualAudioPath)) {
        resolve(actualAudioPath);
      } else {
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

// NEW: STEP 1 - Analyze what type of content this is
async function analyzeContentType(transcription, videoInfo) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  const analysisPrompt = `You are an expert content analyst. Analyze this video transcript and determine exactly what type of content this is.

Video Title: "${videoInfo.title}"
Video Duration: ${videoInfo.duration ? Math.round(videoInfo.duration / 60) + ' minutes' : 'Unknown'}
Uploader: ${videoInfo.uploader || 'Unknown'}

FULL TRANSCRIPT:
${transcription}

Based on the ACTUAL CONTENT being discussed, determine:

1. CONTENT TYPE - Choose the most accurate one:
   - recipe: Cooking/baking instructions with ingredients and steps
   - tutorial: Step-by-step instructions to learn/build something
   - tips: Advice, life hacks, recommendations
   - review: Product/service evaluation with pros/cons
   - fitness: Workout routines, exercises, health advice
   - story: Personal stories, experiences, entertainment
   - news: Current events, updates, reporting
   - educational: Teaching concepts, explaining topics
   - entertainment: Comedy, memes, fun content
   - other: Anything else

2. SUB-CATEGORY - Be very specific (e.g. "sleep improvement tips", "iPhone review", "pasta recipe")

3. KEY ELEMENTS - What are the main things discussed?

4. STRUCTURE NEEDED - How should this be presented?

Respond ONLY with valid JSON:
{
  "contentType": "exact_type_from_list_above",
  "subCategory": "very_specific_description",
  "keyElements": ["element1", "element2", "element3"],
  "targetAudience": "beginner|intermediate|advanced|general",
  "primaryFocus": "main_focus_of_content",
  "hasActionableSteps": true|false,
  "estimatedComplexity": "simple|moderate|complex",
  "presentationStyle": "how_this_should_be_formatted"
}

Be accurate and specific based on what is ACTUALLY being said in the transcript.`;

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
            content: 'You are an expert content analyzer. Always respond with valid JSON only. Be precise and accurate.'
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
      console.log('Content analysis result:', analysis);
      return analysis;
    } catch (parseError) {
      console.error('Failed to parse analysis JSON:', result.choices[0].message.content);
      // Fallback
      return {
        contentType: 'other',
        subCategory: 'general content',
        keyElements: ['video content'],
        targetAudience: 'general',
        primaryFocus: videoInfo.title || 'video content',
        hasActionableSteps: false,
        estimatedComplexity: 'simple',
        presentationStyle: 'general summary'
      };
    }
  } catch (error) {
    console.error('Analysis error:', error);
    throw error;
  }
}

// NEW: STEP 2 - Generate specialized content based on analysis
async function generateSpecializedSummary(transcription, videoInfo, analysis) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  // Create specialized prompt based on content type
  let specializedPrompt = '';
  
  switch (analysis.contentType) {
    case 'tips':
      specializedPrompt = createAdvancedTipsPrompt(transcription, videoInfo, analysis);
      break;
    case 'recipe':
      specializedPrompt = createAdvancedRecipePrompt(transcription, videoInfo, analysis);
      break;
    case 'tutorial':
      specializedPrompt = createAdvancedTutorialPrompt(transcription, videoInfo, analysis);
      break;
    case 'review':
      specializedPrompt = createAdvancedReviewPrompt(transcription, videoInfo, analysis);
      break;
    case 'fitness':
      specializedPrompt = createAdvancedFitnessPrompt(transcription, videoInfo, analysis);
      break;
    case 'story':
      specializedPrompt = createStoryPrompt(transcription, videoInfo, analysis);
      break;
    case 'educational':
      specializedPrompt = createEducationalPrompt(transcription, videoInfo, analysis);
      break;
    default:
      specializedPrompt = createAdvancedGeneralPrompt(transcription, videoInfo, analysis);
  }

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
            content: `You are an expert content processor. Create comprehensive, detailed, and actionable content summaries. Always respond with valid JSON only. Extract ALL relevant details from the transcript.`
          },
          {
            role: 'user', 
            content: specializedPrompt
          }
        ],
        max_tokens: 2500,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      throw new Error(`Specialized summary failed: ${response.status}`);
    }

    const result = await response.json();
    
    try {
      const summary = JSON.parse(result.choices[0].message.content);
      return {
        ...summary,
        contentAnalysis: analysis // Include original analysis
      };
    } catch (parseError) {
      console.error('Failed to parse specialized summary:', result.choices[0].message.content);
      return createFallbackSummary(videoInfo, analysis);
    }
  } catch (error) {
    console.error('Specialized summary error:', error);
    throw error;
  }
}

// ADVANCED TIPS PROMPT - Voor jouw sleep tips video
function createAdvancedTipsPrompt(transcription, videoInfo, analysis) {
  return `Extract and structure ALL tips from this ${analysis.subCategory} video.

Video: "${videoInfo.title}"
Focus: ${analysis.primaryFocus}

COMPLETE TRANSCRIPT:
${transcription}

Create a comprehensive JSON response with EVERY tip mentioned:

{
  "title": "Clear descriptive title",
  "summary": "What this video helps you achieve",
  "targetArea": "${analysis.subCategory}",
  "tips": [
    {
      "tip": "Clear tip title/name",
      "explanation": "Detailed explanation of what to do",
      "whyItWorks": "Scientific/logical reasoning why this works",
      "howToImplement": "Step-by-step how to actually do this",
      "timeToSeeResults": "When you'll notice improvements",
      "difficulty": "Easy|Medium|Hard",
      "commonMistakes": "What people typically do wrong",
      "additionalNotes": "Any extra context or warnings"
    }
  ],
  "implementationPlan": "Suggested order to try these tips",
  "measuringSuccess": "How to know if the tips are working",
  "relatedTopics": ["connected areas or additional resources"],
  "category": "Tips",
  "tags": ["${analysis.subCategory}", "improvement", "lifestyle"],
  "estimated_read_time": 5
}

IMPORTANT: Extract EVERY single tip mentioned. Don't summarize - be comprehensive and detailed. Include all practical advice, methods, techniques, and recommendations discussed.`;
}

// ADVANCED RECIPE PROMPT
function createAdvancedRecipePrompt(transcription, videoInfo, analysis) {
  return `Extract complete recipe details from this cooking video.

Video: "${videoInfo.title}"
Type: ${analysis.subCategory}

COMPLETE TRANSCRIPT:
${transcription}

Extract EVERY ingredient, step, and cooking detail mentioned:

{
  "title": "Recipe name",
  "summary": "Description of the dish",
  "servings": "number mentioned or estimated",
  "totalTime": "total cooking time mentioned",
  "difficulty": "Easy|Medium|Hard",
  "ingredients": [
    {"item": "ingredient name", "amount": "exact quantity mentioned", "notes": "prep instructions"}
  ],
  "equipment": ["all tools/equipment mentioned"],
  "instructions": [
    {"step": 1, "action": "detailed instruction exactly as explained", "time": "duration if mentioned", "tips": "any cooking tips", "temperature": "if mentioned"}
  ],
  "tips": ["all cooking tips and tricks mentioned"],
  "nutritionNotes": "any nutrition info discussed",
  "variations": ["alternative ingredients or methods mentioned"],
  "category": "Recipe",
  "tags": ["cuisine-type", "meal-type", "cooking-method"],
  "estimated_read_time": 6
}

Extract EVERYTHING mentioned - be comprehensive and detailed.`;
}

// ADVANCED TUTORIAL PROMPT
function createAdvancedTutorialPrompt(transcription, videoInfo, analysis) {
  return `Extract complete tutorial instructions from this instructional video.

Video: "${videoInfo.title}"
Type: ${analysis.subCategory}

COMPLETE TRANSCRIPT:
${transcription}

Create detailed tutorial structure:

{
  "title": "Clear tutorial title",
  "summary": "What you'll learn and accomplish",
  "difficulty": "Beginner|Intermediate|Advanced", 
  "timeRequired": "estimated completion time",
  "materialsNeeded": [
    {"item": "tool/material name", "required": true|false, "alternatives": "if mentioned"}
  ],
  "prerequisites": ["skills or knowledge needed beforehand"],
  "steps": [
    {"step": 1, "title": "step name", "instruction": "detailed instruction", "timeEstimate": "duration", "commonMistakes": "what to avoid", "successTips": "how to do it right", "visualCues": "what to look for"}
  ],
  "troubleshooting": [
    {"problem": "common issue mentioned", "solution": "how to fix it"}
  ],
  "finalResult": "what you'll have accomplished",
  "nextSteps": ["what to do after completing"],
  "category": "Tutorial", 
  "tags": ["skill-type", "tools-used", "difficulty"],
  "estimated_read_time": 7
}

Extract ALL instructions, tips, warnings, and details mentioned.`;
}

// STORY PROMPT
function createStoryPrompt(transcription, videoInfo, analysis) {
  return `Structure this personal story/experience video.

Video: "${videoInfo.title}"

COMPLETE TRANSCRIPT:
${transcription}

{
  "title": "Story title",
  "summary": "Brief overview of what happened",
  "storyElements": [
    {"element": "main event/point", "details": "what happened", "impact": "significance or outcome"}
  ],
  "keyMoments": ["important moments or turning points"],
  "lessons": ["what can be learned from this"],
  "emotions": ["main emotional themes"],
  "category": "Story",
  "tags": ["experience-type", "topic"],
  "estimated_read_time": 4
}`;
}

// EDUCATIONAL PROMPT
function createEducationalPrompt(transcription, videoInfo, analysis) {
  return `Structure this educational content.

Video: "${videoInfo.title}"
Topic: ${analysis.subCategory}

COMPLETE TRANSCRIPT:
${transcription}

{
  "title": "Educational topic",
  "summary": "What this teaches",
  "concepts": [
    {"concept": "main concept", "explanation": "detailed explanation", "examples": ["examples given"], "importance": "why this matters"}
  ],
  "keyPoints": ["main learning points"],
  "practicalApplications": ["how to use this knowledge"],
  "additionalResources": ["related topics to explore"],
  "category": "Educational",
  "tags": ["subject", "learning-level"],
  "estimated_read_time": 6
}`;
}

// Fallback for other content types
function createAdvancedGeneralPrompt(transcription, videoInfo, analysis) {
  return `Structure this ${analysis.contentType} content about ${analysis.subCategory}.

Video: "${videoInfo.title}"

COMPLETE TRANSCRIPT:
${transcription}

{
  "title": "Content title", 
  "summary": "Main message or purpose",
  "mainPoints": [
    {"point": "key point", "explanation": "detailed explanation", "importance": "why this matters"}
  ],
  "keyTakeaways": ["actionable insights"],
  "practicalAdvice": ["things viewer can do"],
  "category": "${analysis.contentType}",
  "tags": ["relevant", "tags"],
  "estimated_read_time": 4
}`;
}

// ... (rest of your existing functions like createReviewPrompt, createFitnessPrompt remain the same)

function createFallbackSummary(videoInfo, analysis) {
  return {
    title: videoInfo.title || 'Video Summary',
    summary: `A ${analysis.contentType} about ${analysis.subCategory}`,
    category: analysis.contentType,
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
