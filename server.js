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

// Track channel processing jobs
const channelJobs = new Map();

// Detect URL type
function detectUrlType(url) {
  if (url.includes('/watch?v=') || url.includes('youtu.be/')) {
    return 'video';
  } else if (url.includes('/channel/') || url.includes('/c/') || url.includes('/@') || url.includes('/user/')) {
    return 'channel';
  } else if (url.includes('/playlist?list=')) {
    return 'playlist';
  }
  return 'unknown';
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

// Get all video URLs from a channel or playlist
async function getChannelVideos(channelUrl, maxVideos = 50) {
  console.log(`Fetching videos from channel (max ${maxVideos})...`);

  try {
    const { stdout } = await execPromise(
      `yt-dlp --flat-playlist --dump-json --playlist-end ${maxVideos} "${channelUrl}"`,
      { timeout: 120000, maxBuffer: 50 * 1024 * 1024 }
    );

    const videos = stdout
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          const info = JSON.parse(line);
          return {
            id: info.id,
            title: info.title || 'Unknown',
            url: `https://www.youtube.com/watch?v=${info.id}`
          };
        } catch (e) {
          return null;
        }
      })
      .filter(v => v !== null);

    console.log(`Found ${videos.length} videos`);
    return videos;
  } catch (error) {
    console.error('Error fetching channel videos:', error.message);
    throw new Error('Failed to fetch channel videos: ' + error.message);
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

// Download subtitles from YouTube using yt-dlp
async function downloadSubtitles(youtubeUrl, videoId) {
  const outputPath = path.join(TEMP_DIR, videoId);

  try {
    const cmd = `yt-dlp --skip-download --write-auto-subs --sub-lang "en.*,en" --sub-format vtt -o "${outputPath}" --no-playlist "${youtubeUrl}"`;
    await execPromise(cmd, { timeout: 60000 });

    const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(videoId) && f.endsWith('.vtt'));

    if (files.length > 0) {
      const subtitlePath = path.join(TEMP_DIR, files[0]);
      const vttContent = fs.readFileSync(subtitlePath, 'utf8');
      fs.unlinkSync(subtitlePath);
      return parseVTT(vttContent);
    }

    // Try any language
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
    // Clean up any partial files
    const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(videoId));
    files.forEach(f => {
      try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch (e) {}
    });
    return null;
  }
}

// Parse VTT subtitle format to plain text
function parseVTT(vttContent) {
  const lines = vttContent.split('\n');
  const textLines = [];
  let lastLine = '';

  for (const line of lines) {
    if (line.startsWith('WEBVTT') ||
        line.startsWith('Kind:') ||
        line.startsWith('Language:') ||
        line.includes('-->') ||
        line.trim() === '' ||
        /^\d+$/.test(line.trim())) {
      continue;
    }

    let cleanLine = line
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();

    if (cleanLine && cleanLine !== lastLine) {
      textLines.push(cleanLine);
      lastLine = cleanLine;
    }
  }

  return textLines.join(' ').replace(/\s+/g, ' ').trim();
}

// Process a single video and save to database
async function processVideo(url, videoId, skipExisting = true) {
  // Check if already processed
  if (skipExisting) {
    const [existing] = await pool.execute(
      'SELECT id FROM podcasts WHERE spotify_url = ?',
      [url]
    );
    if (existing.length > 0) {
      return { skipped: true, reason: 'already_processed' };
    }
  }

  // Get video info
  const ytInfo = await getYoutubeInfo(url);

  // Download subtitles
  const transcript = await downloadSubtitles(url, videoId);

  if (!transcript || transcript.length < 50) {
    return { skipped: true, reason: 'no_subtitles' };
  }

  // Analyze with Gemini
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

  let analysis;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysis = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('No JSON found');
    }
  } catch (e) {
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

  return {
    success: true,
    id: insertResult.insertId,
    title: ytInfo.title,
    channel: ytInfo.channel,
    summary: analysis.summary
  };
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

// Process single video or start channel processing
app.post('/api/process', async (req, res) => {
  try {
    const { url, maxVideos = 50 } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      return res.status(400).json({ error: 'Please provide a valid YouTube URL' });
    }

    const urlType = detectUrlType(url);

    if (urlType === 'video') {
      // Single video processing
      const videoId = extractYoutubeId(url);
      if (!videoId) {
        return res.status(400).json({ error: 'Could not extract video ID from URL' });
      }

      const result = await processVideo(url, videoId);

      if (result.skipped) {
        if (result.reason === 'already_processed') {
          return res.status(409).json({ error: 'This URL has already been processed', exists: true });
        } else {
          return res.status(404).json({ error: 'No subtitles available for this video' });
        }
      }

      res.json({
        success: true,
        id: result.id,
        data: {
          podcast_name: result.channel,
          episode_title: result.title,
          summary: result.summary,
          best_part: result.best_part
        }
      });

    } else if (urlType === 'channel' || urlType === 'playlist') {
      // Channel/playlist processing - return job ID immediately
      const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2);

      channelJobs.set(jobId, {
        status: 'starting',
        url: url,
        total: 0,
        processed: 0,
        skipped: 0,
        failed: 0,
        results: []
      });

      res.json({
        success: true,
        type: urlType,
        jobId: jobId,
        message: `Started processing ${urlType}. Use /api/channel-status/${jobId} to check progress.`
      });

      // Process in background
      processChannelAsync(jobId, url, Math.min(maxVideos, 100));

    } else {
      return res.status(400).json({ error: 'Could not determine URL type. Use a video, channel, or playlist URL.' });
    }

  } catch (error) {
    console.error('Process error:', error);
    res.status(500).json({ error: 'Failed to process: ' + error.message });
  }
});

// Background channel processing
async function processChannelAsync(jobId, channelUrl, maxVideos) {
  const job = channelJobs.get(jobId);

  try {
    job.status = 'fetching_videos';
    const videos = await getChannelVideos(channelUrl, maxVideos);
    job.total = videos.length;
    job.status = 'processing';

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      job.currentVideo = video.title;

      try {
        console.log(`[${jobId}] Processing ${i + 1}/${videos.length}: ${video.title}`);
        const result = await processVideo(video.url, video.id);

        if (result.skipped) {
          job.skipped++;
          job.results.push({
            title: video.title,
            status: 'skipped',
            reason: result.reason
          });
        } else {
          job.processed++;
          job.results.push({
            title: video.title,
            status: 'success',
            id: result.id,
            summary: result.summary
          });
        }
      } catch (error) {
        console.error(`[${jobId}] Error processing ${video.title}:`, error.message);
        job.failed++;
        job.results.push({
          title: video.title,
          status: 'failed',
          error: error.message
        });
      }

      // Small delay between videos to avoid rate limiting
      await new Promise(r => setTimeout(r, 1000));
    }

    job.status = 'completed';
    job.currentVideo = null;

  } catch (error) {
    console.error(`[${jobId}] Channel processing error:`, error);
    job.status = 'error';
    job.error = error.message;
  }
}

// Get channel processing status
app.get('/api/channel-status/:jobId', (req, res) => {
  const job = channelJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    status: job.status,
    url: job.url,
    total: job.total,
    processed: job.processed,
    skipped: job.skipped,
    failed: job.failed,
    currentVideo: job.currentVideo,
    results: job.results,
    error: job.error
  });
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
  console.log('Supports: YouTube videos, channels, and playlists');
});
