require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const pool = require('./db');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini AI
if (!process.env.GEMINI_API_KEY) {
  console.error('WARNING: GEMINI_API_KEY environment variable is not set');
}

const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Temp directory for audio files
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Extract YouTube video ID
function extractYoutubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Download audio from YouTube using yt-dlp
async function downloadFromYoutube(youtubeUrl, outputPath) {
  console.log('Downloading from YouTube with yt-dlp...');

  const outputTemplate = outputPath.replace(/\.[^/.]+$/, '');

  try {
    const cmd = `yt-dlp -x --audio-format mp3 --audio-quality 9 -o "${outputTemplate}.%(ext)s" --no-playlist "${youtubeUrl}"`;
    console.log('Running:', cmd);

    await execPromise(cmd, { timeout: 900000 });

    const expectedPath = `${outputTemplate}.mp3`;
    if (fs.existsSync(expectedPath)) {
      return expectedPath;
    }

    const dir = path.dirname(outputPath);
    const base = path.basename(outputTemplate);
    const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
    if (files.length > 0) {
      return path.join(dir, files[0]);
    }

    throw new Error('Downloaded file not found');
  } catch (error) {
    console.error('yt-dlp error:', error.message);
    throw new Error(`Failed to download from YouTube: ${error.message}`);
  }
}

// Get YouTube video info
async function getYoutubeInfo(youtubeUrl) {
  try {
    const { stdout } = await execPromise(
      `yt-dlp --dump-json --no-download "${youtubeUrl}"`,
      { timeout: 30000 }
    );
    const info = JSON.parse(stdout);
    return {
      title: info.title || 'Unknown',
      channel: info.uploader || info.channel || 'Unknown',
      duration: info.duration || 0
    };
  } catch (error) {
    console.error('Could not get YouTube info:', error.message);
    return { title: 'Unknown', channel: 'Unknown', duration: 0 };
  }
}

// Upload file to Gemini and wait for processing
async function uploadToGemini(filePath, mimeType) {
  console.log('Uploading file to Gemini File API...');

  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType: mimeType,
    displayName: path.basename(filePath),
  });

  console.log(`Uploaded file: ${uploadResult.file.name}`);

  let file = uploadResult.file;
  while (file.state === 'PROCESSING') {
    console.log('Waiting for file processing...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    file = await fileManager.getFile(file.name);
  }

  if (file.state === 'FAILED') {
    throw new Error('File processing failed');
  }

  console.log('File ready for use');
  return file;
}

// Delete file from Gemini after use
async function deleteFromGemini(fileName) {
  try {
    await fileManager.deleteFile(fileName);
    console.log('Deleted file from Gemini:', fileName);
  } catch (error) {
    console.error('Failed to delete file from Gemini:', error.message);
  }
}

// Check if URL already exists
app.get('/api/check', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const [rows] = await pool.execute(
      'SELECT id, podcast_name, episode_title, processed_at FROM podcasts WHERE spotify_url = ?',
      [url]
    );

    if (rows.length > 0) {
      return res.json({ exists: true, data: rows[0] });
    }

    res.json({ exists: false });
  } catch (error) {
    console.error('Check error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Process YouTube URL - download audio, transcribe with Gemini
app.post('/api/process', async (req, res) => {
  let audioPath = null;
  let geminiFile = null;

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate YouTube URL
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      return res.status(400).json({ error: 'Please provide a valid YouTube URL' });
    }

    const videoId = extractYoutubeId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Could not extract video ID from URL' });
    }

    // Check if already processed
    const [existing] = await pool.execute(
      'SELECT id FROM podcasts WHERE spotify_url = ?',
      [url]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        error: 'This URL has already been processed',
        exists: true
      });
    }

    // Get video info
    console.log('Getting YouTube video info...');
    const ytInfo = await getYoutubeInfo(url);
    console.log('Video title:', ytInfo.title);

    // Download audio
    audioPath = path.join(TEMP_DIR, `${videoId}.mp3`);
    await downloadFromYoutube(url, audioPath);

    // Verify file exists
    if (!fs.existsSync(audioPath)) {
      return res.status(500).json({ error: 'Failed to download audio file' });
    }

    const stats = fs.statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    console.log(`Audio file size: ${fileSizeMB.toFixed(2)} MB`);

    if (fileSizeMB > 100) {
      fs.unlinkSync(audioPath);
      return res.status(413).json({
        error: 'Audio file is too large. Maximum size is 100MB.',
        size: `${fileSizeMB.toFixed(2)} MB`
      });
    }

    // Upload to Gemini File API
    console.log('Uploading to Gemini...');
    geminiFile = await uploadToGemini(audioPath, 'audio/mp3');

    console.log('Transcribing with Gemini...');

    const prompt = `Listen to this audio and provide the following in JSON format:
{
  "podcast_name": "The name/title of the podcast or channel",
  "episode_title": "The title of this episode/video",
  "transcript": "The full transcript of the audio",
  "summary": "A concise 2-3 sentence summary",
  "best_part": "The most interesting quote or segment (1-3 sentences)"
}

Transcribe the entire audio. If you cannot determine names, use "Unknown".`;

    const result = await model.generateContent([
      prompt,
      {
        fileData: {
          fileUri: geminiFile.uri,
          mimeType: geminiFile.mimeType,
        },
      },
    ]);

    const response = result.response;
    const text = response.text();

    console.log('Gemini response received, parsing...');

    // Parse JSON from response
    let analysis;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Parse error:', parseError);
      analysis = {
        podcast_name: ytInfo.channel,
        episode_title: ytInfo.title,
        transcript: text,
        summary: 'Could not parse summary',
        best_part: 'Could not extract best part'
      };
    }

    // Use YouTube metadata as fallback
    if (!analysis.podcast_name || analysis.podcast_name === 'Unknown') {
      analysis.podcast_name = ytInfo.channel;
    }
    if (!analysis.episode_title || analysis.episode_title === 'Unknown') {
      analysis.episode_title = ytInfo.title;
    }

    // Save to database
    const [insertResult] = await pool.execute(
      `INSERT INTO podcasts (spotify_url, podcast_name, episode_title, transcript, best_part, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        url,
        analysis.podcast_name || 'Unknown',
        analysis.episode_title || 'Unknown',
        analysis.transcript || '',
        analysis.best_part || '',
        analysis.summary || ''
      ]
    );

    // Clean up
    if (audioPath && fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
    if (geminiFile) {
      await deleteFromGemini(geminiFile.name);
    }

    res.json({
      success: true,
      id: insertResult.insertId,
      data: {
        podcast_name: analysis.podcast_name,
        episode_title: analysis.episode_title,
        summary: analysis.summary,
        best_part: analysis.best_part
      }
    });

  } catch (error) {
    console.error('Process error:', error);

    if (audioPath && fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
    if (geminiFile) {
      await deleteFromGemini(geminiFile.name);
    }

    res.status(500).json({ error: 'Failed to process: ' + error.message });
  }
});

// Get all processed podcasts
app.get('/api/podcasts', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, spotify_url, podcast_name, episode_title, summary, best_part, processed_at FROM podcasts ORDER BY processed_at DESC'
    );
    res.json(rows);
  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get single podcast by ID
app.get('/api/podcasts/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM podcasts WHERE id = ?',
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Podcast not found' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('Get error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Health check endpoint for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Accepts YouTube URLs only');
});
