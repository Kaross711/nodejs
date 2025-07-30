// server.js - Complete Verbeterde Railway Backend voor Video Processing
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

    // Step 3: Transcribe with Whisper (auto-detect language)
    const transcription = await transcribeAudio(audioPath);
    console.log('Transcription completed, length:', transcription.length);
    console.log('Transcription preview:', transcription.substring(0, 200) + '...');

    // Step 4: NEW 3-STEP AI PROCESS
    console.log('Starting 3-step AI processing...');
    
    // STEP 4A: Analyze content type (supports multiple languages)
    const contentAnalysis = await analyzeContentType(transcription, videoInfo);
    console.log('Content analysis:', contentAnalysis);
    
    // STEP 4B: Generate specialized summary based on content type
    const summary = await generateSpecializedSummary(transcription, videoInfo, contentAnalysis);
    console.log('Specialized summary generated for type:', contentAnalysis.contentType);

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

// Transcribe audio using OpenAI Whisper - AUTO LANGUAGE DETECTION
async function transcribeAudio(audioPath) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioPath));
    formData.append('model', 'whisper-1');
    // REMOVED: formData.append('language', 'en'); // Now auto-detects language!

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

// NEW: STEP 1 - Analyze content type (MULTILINGUAL SUPPORT)
async function analyzeContentType(transcription, videoInfo) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  const analysisPrompt = `You are an expert content analyst who understands multiple languages. Analyze this video transcript and determine exactly what type of content this is.

Video Title: "${videoInfo.title}"
Video Duration: ${videoInfo.duration ? Math.round(videoInfo.duration / 60) + ' minutes' : 'Unknown'}
Uploader: ${videoInfo.uploader || 'Unknown'}

FULL TRANSCRIPT (may be in Dutch, English, or other languages):
${transcription}

IMPORTANT: 
- The transcript may be in Dutch, English, or other languages - analyze it regardless of language
- Focus on the ACTUAL CONTENT being discussed, not the language
- If you see Dutch words like "SEO", "AI", "effectief", "tools" - understand the context

Based on the ACTUAL CONTENT being discussed, determine:

1. CONTENT TYPE - Choose the most accurate one:
   - recipe: Cooking/baking instructions with ingredients and steps
   - tutorial: Step-by-step instructions to learn/build something (like SEO, AI tools, tech)
   - tips: Advice, life hacks, recommendations, optimization techniques
   - review: Product/service evaluation with pros/cons
   - fitness: Workout routines, exercises, health advice
   - story: Personal stories, experiences, entertainment
   - news: Current events, updates, reporting
   - educational: Teaching concepts, explaining topics
   - entertainment: Comedy, memes, fun content
   - business: Marketing, SEO, business advice, strategies
   - tech: Technology tutorials, software guides, AI tools
   - other: Anything else

2. SUB-CATEGORY - Be very specific about what's being taught/discussed

3. KEY ELEMENTS - What are the main things discussed?

Respond ONLY with valid JSON (respond in English even if input is Dutch):
{
  "contentType": "exact_type_from_list_above",
  "subCategory": "very_specific_description_of_what_is_taught",
  "keyElements": ["element1", "element2", "element3"],
  "targetAudience": "beginner|intermediate|advanced|general",
  "primaryFocus": "main_focus_of_content", 
  "hasActionableSteps": true|false,
  "estimatedComplexity": "simple|moderate|complex",
  "presentationStyle": "how_this_should_be_formatted",
  "language": "detected_language_of_content",
  "mainTopics": ["list", "of", "main", "topics", "discussed"]
}

Examples for context:
- If discussing SEO tools and AI → contentType: "tutorial" or "business"
- If showing step-by-step software usage → contentType: "tutorial" 
- If giving marketing advice → contentType: "tips" or "business"

Be accurate and specific based on what is ACTUALLY being said in the transcript, regardless of language.`;

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
            content: 'You are an expert multilingual content analyzer. You understand Dutch, English, and other languages. Always respond with valid JSON only. Be precise and accurate regardless of input language.'
          },
          {
            role: 'user', 
            content: analysisPrompt
          }
        ],
        max_tokens: 600,
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`Content analysis failed: ${response.status}`);
    }

    const result = await response.json();
    
    try {
      const analysis = JSON.parse(result.choices[0].message.content);
      console.log('Multilingual content analysis result:', analysis);
      return analysis;
    } catch (parseError) {
      console.error('Failed to parse analysis JSON:', result.choices[0].message.content);
      // Fallback voor SEO/business content
      return {
        contentType: 'tutorial',
        subCategory: 'SEO and AI tools',
        keyElements: ['SEO optimization', 'AI tools', 'digital marketing'],
        targetAudience: 'intermediate',
        primaryFocus: videoInfo.title || 'business tutorial',
        hasActionableSteps: true,
        estimatedComplexity: 'moderate',
        presentationStyle: 'step-by-step tutorial',
        language: 'dutch',
        mainTopics: ['SEO', 'AI', 'business']
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
    case 'business':
      specializedPrompt = createBusinessPrompt(transcription, videoInfo, analysis);
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
    case 'tech':
      specializedPrompt = createTechPrompt(transcription, videoInfo, analysis);
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
            content: `You are an expert content processor who understands multiple languages. Create comprehensive, detailed, and actionable content summaries. Always respond with valid JSON only. Extract ALL relevant details from the transcript. If input is in Dutch, translate key information to English in your response.`
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

// ADVANCED TIPS PROMPT - Voor sleep tips, life hacks, etc.
function createAdvancedTipsPrompt(transcription, videoInfo, analysis) {
  return `Extract and structure ALL tips from this ${analysis.language || 'multilingual'} video about ${analysis.subCategory}.

Video: "${videoInfo.title}"
Focus: ${analysis.primaryFocus}
Language: ${analysis.language || 'unknown'}

COMPLETE TRANSCRIPT:
${transcription}

Create a comprehensive JSON response with EVERY tip mentioned (translate to English if needed):

{
  "title": "Clear descriptive title in English",
  "summary": "What this video helps you achieve",
  "targetArea": "${analysis.subCategory}",
  "tips": [
    {
      "tip": "Clear tip title/name in English",
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

IMPORTANT: Extract EVERY single tip mentioned. Translate Dutch content to clear English. Don't summarize - be comprehensive and detailed.`;
}

// ADVANCED TUTORIAL PROMPT - Voor SEO, tech, business tutorials
function createAdvancedTutorialPrompt(transcription, videoInfo, analysis) {
  return `Extract complete tutorial instructions from this ${analysis.language || 'multilingual'} instructional video about ${analysis.subCategory}.

Video: "${videoInfo.title}"
Type: ${analysis.subCategory}
Main Topics: ${analysis.mainTopics?.join(', ') || 'tutorial content'}
Language: ${analysis.language || 'unknown'}

COMPLETE TRANSCRIPT:
${transcription}

Create detailed tutorial structure (translate to English if needed):

{
  "title": "Clear tutorial title in English",
  "summary": "What you'll learn and accomplish from this tutorial",
  "difficulty": "Beginner|Intermediate|Advanced", 
  "timeRequired": "estimated time to implement these techniques",
  "toolsNeeded": [
    {"tool": "software/platform name", "required": true|false, "alternatives": "if mentioned", "cost": "free/paid if mentioned"}
  ],
  "prerequisites": ["skills or knowledge needed beforehand"],
  "steps": [
    {
      "step": 1, 
      "title": "step name in English", 
      "instruction": "detailed instruction translated to English", 
      "timeEstimate": "duration if mentioned", 
      "commonMistakes": "what to avoid", 
      "successTips": "how to do it right", 
      "visualCues": "what to look for",
      "tools": ["specific tools used in this step"]
    }
  ],
  "troubleshooting": [
    {"problem": "common issue mentioned", "solution": "how to fix it"}
  ],
  "expectedResults": "what outcomes you should see",
  "nextSteps": ["what to do after completing this tutorial"],
  "additionalResources": ["websites, tools, or concepts mentioned"],
  "category": "Tutorial", 
  "tags": ["${analysis.mainTopics?.join('", "') || 'tutorial'}"],
  "estimated_read_time": 8
}

IMPORTANT: 
- Extract ALL steps, tools, and techniques mentioned
- Translate Dutch content to clear English instructions
- Include all software/tools/platforms mentioned
- Focus on actionable, implementable steps`;
}

// BUSINESS PROMPT - Voor SEO, marketing, business advice
function createBusinessPrompt(transcription, videoInfo, analysis) {
  return `Extract business advice and strategies from this ${analysis.language || 'multilingual'} business video about ${analysis.subCategory}.

Video: "${videoInfo.title}"
Focus: ${analysis.subCategory}
Topics: ${analysis.mainTopics?.join(', ') || 'business'}

COMPLETE TRANSCRIPT:
${transcription}

Create comprehensive business strategy guide (translate to English if needed):

{
  "title": "Business strategy/advice title in English",
  "summary": "What business goal this helps achieve",
  "targetArea": "${analysis.subCategory}",
  "strategies": [
    {
      "strategy": "strategy name in English",
      "explanation": "what this strategy involves",
      "implementation": "step-by-step how to implement this",
      "benefits": "expected outcomes and results",
      "difficulty": "Easy|Medium|Hard",
      "timeframe": "how long to see results",
      "tools": ["tools or platforms needed"],
      "metrics": "how to measure success",
      "examples": "specific examples mentioned"
    }
  ],
  "actionPlan": "step-by-step implementation guide",
  "commonPitfalls": ["mistakes to avoid"],
  "successMetrics": ["how to track progress"],
  "resources": ["tools, websites, or platforms mentioned"],
  "category": "Business",
  "tags": ["${analysis.subCategory}", "strategy", "marketing"],
  "estimated_read_time": 7
}

Extract ALL strategies, tools, and actionable advice mentioned.`;
}

// RECIPE PROMPT
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
}`;
}

// REVIEW PROMPT
function createAdvancedReviewPrompt(transcription, videoInfo, analysis) {
  return `Extract comprehensive review information from this product/service review.

Video: "${videoInfo.title}"
Product: ${analysis.subCategory}

COMPLETE TRANSCRIPT:
${transcription}

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
  "estimated_read_time": 5
}`;
}

// FITNESS PROMPT
function createAdvancedFitnessPrompt(transcription, videoInfo, analysis) {
  return `Extract fitness routine from this workout video.

Video: "${videoInfo.title}"
Type: ${analysis.subCategory}

COMPLETE TRANSCRIPT:
${transcription}

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
  "estimated_read_time": 6
}`;
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

// TECH PROMPT
function createTechPrompt(transcription, videoInfo, analysis) {
  return `Extract technical information from this technology video.

Video: "${videoInfo.title}"
Topic: ${analysis.subCategory}

COMPLETE TRANSCRIPT:
${transcription}

{
  "title": "Technology guide title",
  "summary": "What this technology tutorial covers",
  "techStack": ["technologies, tools, or software covered"],
  "steps": [
    {"step": 1, "action": "what to do", "code": "code examples if any", "explanation": "why this step"}
  ],
  "requirements": ["system requirements or prerequisites"],
  "troubleshooting": ["common issues and solutions"],
  "resources": ["links, tools, or documentation mentioned"],
  "category": "Tech",
  "tags": ["technology-type", "skill-level"],
  "estimated_read_time": 7
}`;
}

// FALLBACK GENERAL PROMPT
function createAdvancedGeneralPrompt(transcription, videoInfo, analysis) {
  return `Structure this ${analysis.contentType} content about ${analysis.subCategory}.

Video: "${videoInfo.title}"
Type: ${analysis.contentType}
Language: ${analysis.language || 'unknown'}

COMPLETE TRANSCRIPT:
${transcription}

Create comprehensive summary (translate to English if needed):

{
  "title": "Content title in English", 
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

// Fallback summary
function createFallbackSummary(videoInfo, analysis) {
  return {
    title: videoInfo.title || 'Video Summary',
    summary: `A ${analysis.contentType} about ${analysis.subCategory}`,
    category: analysis.contentType,
    tags: [analysis.contentType, 'video'],
    estimated_read_time: 3,
    contentAnalysis: analysis
  };
}

app.listen(PORT, () => {
  console.log(`Video processing server running on port ${PORT}`);
  console.log('Health check: GET /health');
  console.log('Process video: POST /process-video');
});

module.exports = app;
