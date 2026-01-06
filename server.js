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

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini AI
if (!process.env.GEMINI_API_KEY) {
  console.error('WARNING: GEMINI_API_KEY environment variable is not set');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Temp directory for subtitle files
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

// Download subtitles from YouTube using yt-dlp
async function downloadSubtitles(youtubeUrl, videoId) {
  console.log('Downloading subtitles from YouTube...');

  const outputPath = path.join(TEMP_DIR, videoId);

  try {
    // Try to get auto-generated subtitles in English, then any language
    const cmd = `yt-dlp --skip-download --write-auto-subs --sub-lang "en.*,en" --sub-format vtt -o "${outputPath}" --no-playlist "${youtubeUrl}"`;
    console.log('Running:', cmd);

    await execPromise(cmd, { timeout: 60000 });

    // Find the downloaded subtitle file
    const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(videoId) && f.endsWith('.vtt'));

    if (files.length > 0) {
      const subtitlePath = path.join(TEMP_DIR, files[0]);
      const vttContent = fs.readFileSync(subtitlePath, 'utf8');

      // Clean up file
      fs.unlinkSync(subtitlePath);

      // Parse VTT to plain text
      const transcript = parseVTT(vttContent);
      return transcript;
    }

    // If no English subs, try any available subs
    const cmd2 = `yt-dlp --skip-download --write-auto-subs --sub-format vtt -o "${outputPath}" --no-playlist "${youtubeUrl}"`;
    await execPromise(cmd2, { timeout: 60000 });

    const files2 = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(videoId) && f.endsWith('.vtt'));

    if (files2.length > 0) {
      const subtitlePath = path.join(TEMP_DIR, files2[0]);
      const vttContent = fs.readFileSync(subtitlePath, 'utf8');
      fs.unlinkSync(subtitlePath);
      return parseVTT(vttContent);
    }

    return null;
  } catch (error) {
    console.error('Subtitle download error:', error.message);

    // Clean up any partial files
    const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(videoId));
    files.forEach(f => {
      try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch (e) {}
    });

    return null;
  }
}

// Parse VTT subtitle format to plain text (remove duplicates from auto-generated subs)
function parseVTT(vttContent) {
  const lines = vttContent.split('\n');
  const textLines = [];
  let lastLine = '';

  for (const line of lines) {
    // Skip header, timestamps, and empty lines
    if (line.startsWith('WEBVTT') ||
        line.startsWith('Kind:') ||
        line.startsWith('Language:') ||
        line.includes('-->') ||
        line.trim() === '' ||
        /^\d+$/.test(line.trim())) {
      continue;
    }

    // Remove VTT tags like <c>, </c>, <00:00:00.000>
    let cleanLine = line
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();

    // Skip if same as last line (auto-generated subs have lots of duplicates)
    if (cleanLine && cleanLine !== lastLine) {
      textLines.push(cleanLine);
      lastLine = cleanLine;
    }
  }

  return textLines.join(' ').replace(/\s+/g, ' ').trim();
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

// Process YouTube URL - get subtitles, analyze with Gemini
app.post('/api/process', async (req, res) => {
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
    console.log('Channel:', ytInfo.channel);

    // Download subtitles
    console.log('Fetching subtitles...');
    const transcript = await downloadSubtitles(url, videoId);

    if (!transcript || transcript.length < 50) {
      return res.status(404).json({
        error: 'No subtitles available for this video. The video may not have captions enabled.',
        suggestion: 'Try a different video that has subtitles/captions available.'
      });
    }

    console.log(`Transcript length: ${transcript.length} characters`);

    // Use Gemini to analyze the transcript
    console.log('Analyzing transcript with Gemini...');

    const prompt = `Analyze this YouTube video transcript and provide the following in JSON format:
{
  "summary": "A concise 2-3 sentence summary of the video content",
  "best_part": "The most interesting, insightful, or valuable quote or segment (1-3 sentences, exact quote from the transcript)"
}

Video Title: ${ytInfo.title}
Channel: ${ytInfo.channel}

Transcript:
${transcript.substring(0, 30000)}`;

    const result = await model.generateContent(prompt);
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
        summary: 'Could not generate summary',
        best_part: 'Could not extract best part'
      };
    }

    // Save to database
    const [insertResult] = await pool.execute(
      `INSERT INTO podcasts (spotify_url, podcast_name, episode_title, transcript, best_part, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        url,
        ytInfo.channel || 'Unknown',
        ytInfo.title || 'Unknown',
        transcript,
        analysis.best_part || '',
        analysis.summary || ''
      ]
    );

    res.json({
      success: true,
      id: insertResult.insertId,
      data: {
        podcast_name: ytInfo.channel,
        episode_title: ytInfo.title,
        summary: analysis.summary,
        best_part: analysis.best_part
      }
    });

  } catch (error) {
    console.error('Process error:', error);
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
  console.log('Accepts YouTube URLs - fetches subtitles directly (no audio download)');
});
