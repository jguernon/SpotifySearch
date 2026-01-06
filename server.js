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

// Track AI processing jobs
const aiJobs = new Map();

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

    // Get best thumbnail
    let thumbnail = null;
    if (info.thumbnail) {
      thumbnail = info.thumbnail;
    } else if (info.thumbnails && info.thumbnails.length > 0) {
      // Get highest quality thumbnail
      thumbnail = info.thumbnails[info.thumbnails.length - 1].url;
    }

    return {
      title: info.title || 'Unknown',
      channel: info.uploader || info.channel || 'Unknown',
      duration: info.duration || 0,
      thumbnail: thumbnail
    };
  } catch (error) {
    console.error('Could not get YouTube info:', error.message);
    return { title: 'Unknown', channel: 'Unknown', duration: 0, thumbnail: null };
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

  // Save to database with thumbnail
  const [insertResult] = await pool.execute(
    `INSERT INTO podcasts (spotify_url, podcast_name, episode_title, transcript, best_part, summary, thumbnail_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      url,
      ytInfo.channel || 'Unknown',
      ytInfo.title || 'Unknown',
      transcript,
      analysis.best_part || '',
      analysis.summary || '',
      ytInfo.thumbnail || null
    ]
  );

  return {
    success: true,
    id: insertResult.insertId,
    title: ytInfo.title,
    channel: ytInfo.channel,
    summary: analysis.summary,
    thumbnail: ytInfo.thumbnail
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
    const allVideos = await getChannelVideos(channelUrl, maxVideos);

    // Get already processed video URLs to skip them
    const [processed] = await pool.execute('SELECT spotify_url FROM podcasts');
    const processedUrls = new Set(processed.map(p => p.spotify_url));

    // Filter out already processed videos
    const newVideos = allVideos.filter(v => !processedUrls.has(v.url));
    const skippedCount = allVideos.length - newVideos.length;

    job.total = newVideos.length;
    job.skipped = skippedCount;
    job.status = 'processing';

    console.log(`[${jobId}] Found ${allVideos.length} videos, ${skippedCount} already processed, ${newVideos.length} new to process`);

    for (let i = 0; i < newVideos.length; i++) {
      const video = newVideos[i];
      job.currentVideo = video.title;

      try {
        console.log(`[${jobId}] Processing ${i + 1}/${newVideos.length}: ${video.title}`);
        const result = await processVideo(video.url, video.id, false); // skipExisting=false since we already filtered

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

// ============================================
// CHANNEL MANAGEMENT ENDPOINTS
// ============================================

// Get all channels with stats
app.get('/api/channels', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        podcast_name as channel_name,
        MIN(spotify_url) as channel_url,
        COUNT(*) as videos_processed,
        MAX(processed_at) as last_processed,
        MAX(ai_processed_at) as ai_processed_at
      FROM podcasts
      GROUP BY podcast_name
      ORDER BY last_processed DESC
    `);

    // For each channel, we need to get total available videos
    // This is stored in the channels table or we estimate from what we have
    const [channelStats] = await pool.execute(`
      SELECT channel_name, total_videos, channel_url
      FROM channels
      WHERE channel_name IS NOT NULL
    `);

    const statsMap = new Map(channelStats.map(c => [c.channel_name, c]));

    const channels = rows.map(row => {
      const stats = statsMap.get(row.channel_name);
      return {
        channel_name: row.channel_name,
        channel_url: stats?.channel_url || extractChannelUrl(row.channel_url),
        videos_processed: row.videos_processed,
        total_available: stats?.total_videos || row.videos_processed,
        last_processed: row.last_processed,
        ai_processed_at: row.ai_processed_at
      };
    });

    res.json(channels);
  } catch (error) {
    console.error('Channels error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Extract channel URL from video URL
function extractChannelUrl(videoUrl) {
  if (!videoUrl) return null;
  // We can't reliably extract channel URL from video URL without API call
  return null;
}

// Refresh channel video count
app.post('/api/refresh-channel-count', async (req, res) => {
  try {
    const { channelName, channelUrl } = req.body;

    if (!channelUrl) {
      return res.status(400).json({ error: 'Channel URL is required' });
    }

    // Get total videos from channel
    const { stdout } = await execPromise(
      `yt-dlp --flat-playlist --dump-json "${channelUrl}" 2>/dev/null | wc -l`,
      { timeout: 120000 }
    );

    const totalVideos = parseInt(stdout.trim()) || 0;

    // Update or insert into channels table
    await pool.execute(`
      INSERT INTO channels (channel_name, channel_url, total_videos, updated_at)
      VALUES (?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        total_videos = VALUES(total_videos),
        channel_url = VALUES(channel_url),
        updated_at = NOW()
    `, [channelName, channelUrl, totalVideos]);

    res.json({ success: true, totalVideos });
  } catch (error) {
    console.error('Refresh count error:', error);
    res.status(500).json({ error: 'Failed to refresh count: ' + error.message });
  }
});

// Process missing videos for a channel
app.post('/api/process-missing', async (req, res) => {
  try {
    const { channelName, channelUrl } = req.body;

    if (!channelUrl) {
      return res.status(400).json({ error: 'Channel URL is required' });
    }

    // Get already processed video IDs for this channel
    const [processed] = await pool.execute(
      'SELECT spotify_url FROM podcasts WHERE podcast_name = ?',
      [channelName]
    );
    const processedIds = new Set(processed.map(p => extractYoutubeId(p.spotify_url)));

    // Start background job
    const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2);

    channelJobs.set(jobId, {
      status: 'starting',
      url: channelUrl,
      total: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      results: []
    });

    res.json({ success: true, jobId });

    // Process in background - only missing videos
    processMissingVideosAsync(jobId, channelUrl, processedIds);

  } catch (error) {
    console.error('Process missing error:', error);
    res.status(500).json({ error: 'Failed to start processing: ' + error.message });
  }
});

// Background processing for missing videos
async function processMissingVideosAsync(jobId, channelUrl, processedIds) {
  const job = channelJobs.get(jobId);

  try {
    job.status = 'fetching_videos';
    const allVideos = await getChannelVideos(channelUrl, 500);

    // Filter out already processed
    const missingVideos = allVideos.filter(v => !processedIds.has(v.id));

    job.total = missingVideos.length;
    job.status = 'processing';

    console.log(`[${jobId}] Found ${missingVideos.length} missing videos to process`);

    for (let i = 0; i < missingVideos.length; i++) {
      const video = missingVideos[i];
      job.currentVideo = video.title;

      try {
        console.log(`[${jobId}] Processing ${i + 1}/${missingVideos.length}: ${video.title}`);
        const result = await processVideo(video.url, video.id);

        if (result.skipped) {
          job.skipped++;
          job.results.push({ title: video.title, status: 'skipped', reason: result.reason });
        } else {
          job.processed++;
          job.results.push({ title: video.title, status: 'success', id: result.id });
        }
      } catch (error) {
        console.error(`[${jobId}] Error:`, error.message);
        job.failed++;
        job.results.push({ title: video.title, status: 'failed', error: error.message });
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    job.status = 'completed';
    job.currentVideo = null;

  } catch (error) {
    console.error(`[${jobId}] Error:`, error);
    job.status = 'error';
    job.error = error.message;
  }
}

// ============================================
// AI PROCESSING & KEYWORD ENDPOINTS
// ============================================

// Get AI processing status
app.get('/api/ai-status', async (req, res) => {
  try {
    const [keywordCount] = await pool.execute('SELECT COUNT(DISTINCT keyword) as count FROM keywords');
    const [videoCount] = await pool.execute('SELECT COUNT(*) as count FROM podcasts WHERE keywords IS NOT NULL AND keywords != ""');
    const [lastProcessed] = await pool.execute('SELECT MAX(ai_processed_at) as last FROM podcasts WHERE ai_processed_at IS NOT NULL');
    const [missingThumbnails] = await pool.execute('SELECT COUNT(*) as count FROM podcasts WHERE thumbnail_url IS NULL OR thumbnail_url = ""');

    res.json({
      total_keywords: keywordCount[0].count || 0,
      videos_analyzed: videoCount[0].count || 0,
      last_processed: lastProcessed[0].last,
      missing_thumbnails: missingThumbnails[0].count || 0
    });
  } catch (error) {
    console.error('AI status error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Start AI processing for all videos
app.post('/api/process-ai', async (req, res) => {
  try {
    const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2);

    aiJobs.set(jobId, {
      status: 'starting',
      total: 0,
      processed: 0,
      keywords_count: 0
    });

    res.json({ success: true, jobId });

    // Process in background
    processAiAsync(jobId);

  } catch (error) {
    console.error('AI processing error:', error);
    res.status(500).json({ error: 'Failed to start AI processing' });
  }
});

// Get AI job status
app.get('/api/ai-status/:jobId', (req, res) => {
  const job = aiJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json(job);
});

// Background AI processing
async function processAiAsync(jobId) {
  const job = aiJobs.get(jobId);

  try {
    // Get blacklisted keywords
    const [blacklistRows] = await pool.execute('SELECT keyword FROM keyword_blacklist');
    const blacklist = new Set(blacklistRows.map(r => r.keyword.toLowerCase()));

    // Get all videos that haven't been AI processed or need reprocessing
    const [videos] = await pool.execute(`
      SELECT id, episode_title, podcast_name, summary, transcript
      FROM podcasts
      WHERE (keywords IS NULL OR keywords = '')
      ORDER BY processed_at DESC
    `);

    job.total = videos.length;
    job.status = 'processing';

    console.log(`[AI-${jobId}] Processing ${videos.length} videos for keywords (${blacklist.size} blacklisted terms)`);

    const allKeywords = new Map();

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];

      try {
        // Extract keywords using Gemini
        const textToAnalyze = `Title: ${video.episode_title}\nChannel: ${video.podcast_name}\nSummary: ${video.summary || ''}\n\nTranscript excerpt: ${(video.transcript || '').substring(0, 10000)}`;

        const prompt = `Extract 5-10 main keywords/topics from this video content. Return ONLY a JSON array of lowercase keywords, no explanations. Focus on main subjects, people mentioned, concepts discussed.

Example output: ["artificial intelligence", "elon musk", "space exploration", "neural networks"]

Content:
${textToAnalyze}`;

        const result = await model.generateContent(prompt);
        const text = result.response.text();

        let keywords = [];
        try {
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            keywords = JSON.parse(jsonMatch[0]);
          }
        } catch (e) {
          // Try to extract comma-separated keywords
          keywords = text.split(',').map(k => k.trim().toLowerCase().replace(/["\[\]]/g, '')).filter(k => k.length > 2);
        }

        // Clean, filter blacklisted, and limit keywords
        keywords = keywords
          .map(k => k.toLowerCase().trim())
          .filter(k => k.length > 2 && k.length < 50)
          .filter(k => !blacklist.has(k))
          .slice(0, 10);

        // Update video with keywords
        const keywordsStr = keywords.join(',');
        await pool.execute(
          'UPDATE podcasts SET keywords = ?, ai_processed_at = NOW() WHERE id = ?',
          [keywordsStr, video.id]
        );

        // Track keyword counts (only non-blacklisted)
        keywords.forEach(k => {
          allKeywords.set(k, (allKeywords.get(k) || 0) + 1);
        });

        job.processed++;
        console.log(`[AI-${jobId}] Processed ${i + 1}/${videos.length}: ${video.episode_title} - ${keywords.length} keywords`);

        // Rate limiting
        await new Promise(r => setTimeout(r, 500));

      } catch (error) {
        console.error(`[AI-${jobId}] Error processing video ${video.id}:`, error.message);
        job.processed++;
      }
    }

    // Save all keywords to keywords table (excluding blacklisted)
    console.log(`[AI-${jobId}] Saving ${allKeywords.size} unique keywords`);

    for (const [keyword, count] of allKeywords) {
      if (!blacklist.has(keyword)) {
        await pool.execute(`
          INSERT INTO keywords (keyword, count, updated_at)
          VALUES (?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            count = count + VALUES(count),
            updated_at = NOW()
        `, [keyword, count]);
      }
    }

    job.status = 'completed';
    job.keywords_count = allKeywords.size;

    console.log(`[AI-${jobId}] Completed! ${allKeywords.size} keywords extracted`);

  } catch (error) {
    console.error(`[AI-${jobId}] Error:`, error);
    job.status = 'error';
    job.error = error.message;
  }
}

// Get popular keywords (excluding blacklisted)
app.get('/api/keywords', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const includeBlacklisted = req.query.includeBlacklisted === 'true';

    let query;
    if (includeBlacklisted) {
      query = `
        SELECT k.keyword, k.count, (b.keyword IS NOT NULL) as is_blacklisted
        FROM keywords k
        LEFT JOIN keyword_blacklist b ON k.keyword = b.keyword
        ORDER BY k.count DESC
        LIMIT ?
      `;
    } else {
      query = `
        SELECT k.keyword, k.count, false as is_blacklisted
        FROM keywords k
        LEFT JOIN keyword_blacklist b ON k.keyword = b.keyword
        WHERE b.keyword IS NULL
        ORDER BY k.count DESC
        LIMIT ?
      `;
    }

    const [rows] = await pool.execute(query, [limit]);
    res.json(rows);
  } catch (error) {
    console.error('Keywords error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// ============================================
// KEYWORD BLACKLIST ENDPOINTS
// ============================================

// Get all blacklisted keywords
app.get('/api/keyword-blacklist', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT keyword, created_at FROM keyword_blacklist ORDER BY keyword');
    res.json(rows);
  } catch (error) {
    console.error('Blacklist error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Add keyword to blacklist
app.post('/api/keyword-blacklist', async (req, res) => {
  try {
    const { keyword } = req.body;

    if (!keyword || keyword.trim().length < 2) {
      return res.status(400).json({ error: 'Keyword must be at least 2 characters' });
    }

    const cleanKeyword = keyword.trim().toLowerCase();

    await pool.execute(
      'INSERT IGNORE INTO keyword_blacklist (keyword) VALUES (?)',
      [cleanKeyword]
    );

    // Also remove from keywords table
    await pool.execute('DELETE FROM keywords WHERE keyword = ?', [cleanKeyword]);

    res.json({ success: true, keyword: cleanKeyword });
  } catch (error) {
    console.error('Add blacklist error:', error);
    res.status(500).json({ error: 'Failed to add to blacklist' });
  }
});

// Remove keyword from blacklist
app.delete('/api/keyword-blacklist/:keyword', async (req, res) => {
  try {
    const keyword = decodeURIComponent(req.params.keyword);

    await pool.execute('DELETE FROM keyword_blacklist WHERE keyword = ?', [keyword]);

    res.json({ success: true });
  } catch (error) {
    console.error('Remove blacklist error:', error);
    res.status(500).json({ error: 'Failed to remove from blacklist' });
  }
});

// Bulk add keywords to blacklist
app.post('/api/keyword-blacklist/bulk', async (req, res) => {
  try {
    const { keywords } = req.body;

    if (!Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'Keywords array is required' });
    }

    const cleanKeywords = keywords
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length >= 2);

    for (const keyword of cleanKeywords) {
      await pool.execute('INSERT IGNORE INTO keyword_blacklist (keyword) VALUES (?)', [keyword]);
      await pool.execute('DELETE FROM keywords WHERE keyword = ?', [keyword]);
    }

    res.json({ success: true, count: cleanKeywords.length });
  } catch (error) {
    console.error('Bulk blacklist error:', error);
    res.status(500).json({ error: 'Failed to add to blacklist' });
  }
});

// ============================================
// SEARCH ENDPOINT
// ============================================

// Extract context snippets from transcript around search terms
function extractContextSnippets(transcript, searchTerms, maxSnippets = 3, contextChars = 150) {
  if (!transcript) return [];

  const snippets = [];
  const lowerTranscript = transcript.toLowerCase();

  for (const term of searchTerms) {
    if (term.length < 2) continue;

    let startIndex = 0;
    while (snippets.length < maxSnippets) {
      const index = lowerTranscript.indexOf(term.toLowerCase(), startIndex);
      if (index === -1) break;

      // Get context around the match
      const snippetStart = Math.max(0, index - contextChars);
      const snippetEnd = Math.min(transcript.length, index + term.length + contextChars);

      let snippet = transcript.substring(snippetStart, snippetEnd);

      // Clean up snippet boundaries
      if (snippetStart > 0) snippet = '...' + snippet.substring(snippet.indexOf(' ') + 1);
      if (snippetEnd < transcript.length) snippet = snippet.substring(0, snippet.lastIndexOf(' ')) + '...';

      // Check if this snippet overlaps with existing ones
      const overlaps = snippets.some(s => {
        const sLower = s.text.toLowerCase();
        return sLower.includes(snippet.toLowerCase().substring(10, 50)) ||
               snippet.toLowerCase().includes(sLower.substring(10, 50));
      });

      if (!overlaps && snippet.length > 20) {
        snippets.push({
          text: snippet,
          matchedTerm: term
        });
      }

      startIndex = index + term.length;
    }

    if (snippets.length >= maxSnippets) break;
  }

  return snippets;
}

// Search videos by keywords and text (including transcript)
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;

    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const searchTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    const searchPattern = `%${query}%`;

    // Search in title, summary, keywords, and transcript
    const [rows] = await pool.execute(`
      SELECT
        id, spotify_url, podcast_name, episode_title, summary, keywords, processed_at,
        thumbnail_url, transcript,
        (
          (CASE WHEN LOWER(episode_title) LIKE ? THEN 50 ELSE 0 END) +
          (CASE WHEN LOWER(keywords) LIKE ? THEN 40 ELSE 0 END) +
          (CASE WHEN LOWER(summary) LIKE ? THEN 30 ELSE 0 END) +
          (CASE WHEN LOWER(transcript) LIKE ? THEN 20 ELSE 0 END)
        ) as relevance_score
      FROM podcasts
      WHERE
        LOWER(episode_title) LIKE ? OR
        LOWER(keywords) LIKE ? OR
        LOWER(summary) LIKE ? OR
        LOWER(transcript) LIKE ?
      ORDER BY relevance_score DESC, processed_at DESC
      LIMIT 50
    `, [searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern]);

    // Process results to extract context snippets
    const results = rows.map(row => {
      const snippets = extractContextSnippets(row.transcript, searchTerms);

      // Generate Spotify search URL
      const spotifySearchUrl = `https://open.spotify.com/search/${encodeURIComponent(row.episode_title)}`;

      return {
        id: row.id,
        spotify_url: row.spotify_url,
        podcast_name: row.podcast_name,
        episode_title: row.episode_title,
        summary: row.summary,
        keywords: row.keywords,
        processed_at: row.processed_at,
        thumbnail_url: row.thumbnail_url,
        relevance_score: row.relevance_score,
        context_snippets: snippets,
        spotify_search_url: spotifySearchUrl
      };
    });

    res.json(results);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ============================================
// THUMBNAIL BACKFILL ENDPOINT
// ============================================

// Backfill thumbnails for existing videos
app.post('/api/backfill-thumbnails', async (req, res) => {
  try {
    const jobId = Date.now().toString(36) + Math.random().toString(36).substr(2);

    aiJobs.set(jobId, {
      status: 'starting',
      total: 0,
      processed: 0,
      type: 'thumbnails'
    });

    res.json({ success: true, jobId });

    // Process in background
    backfillThumbnailsAsync(jobId);

  } catch (error) {
    console.error('Backfill thumbnails error:', error);
    res.status(500).json({ error: 'Failed to start thumbnail backfill' });
  }
});

// Background thumbnail backfill
async function backfillThumbnailsAsync(jobId) {
  const job = aiJobs.get(jobId);

  try {
    // Get videos without thumbnails
    const [videos] = await pool.execute(`
      SELECT id, spotify_url, episode_title
      FROM podcasts
      WHERE thumbnail_url IS NULL OR thumbnail_url = ''
    `);

    job.total = videos.length;
    job.status = 'processing';

    console.log(`[Thumbnails-${jobId}] Backfilling ${videos.length} videos`);

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];

      try {
        const ytInfo = await getYoutubeInfo(video.spotify_url);

        if (ytInfo.thumbnail) {
          await pool.execute(
            'UPDATE podcasts SET thumbnail_url = ? WHERE id = ?',
            [ytInfo.thumbnail, video.id]
          );
          console.log(`[Thumbnails-${jobId}] Updated ${i + 1}/${videos.length}: ${video.episode_title}`);
        }

        job.processed++;

        // Rate limiting
        await new Promise(r => setTimeout(r, 300));

      } catch (error) {
        console.error(`[Thumbnails-${jobId}] Error on video ${video.id}:`, error.message);
        job.processed++;
      }
    }

    job.status = 'completed';
    console.log(`[Thumbnails-${jobId}] Completed! ${job.processed} thumbnails updated`);

  } catch (error) {
    console.error(`[Thumbnails-${jobId}] Error:`, error);
    job.status = 'error';
    job.error = error.message;
  }
}

// Get indexed stats for public footer
app.get('/api/indexed-stats', async (req, res) => {
  try {
    // Get total episodes count
    const [totalCount] = await pool.execute('SELECT COUNT(*) as total FROM podcasts');

    // Get channels with their episode counts and last processed date
    const [channels] = await pool.execute(`
      SELECT
        podcast_name as name,
        COUNT(*) as episodes,
        MAX(processed_at) as last_scan
      FROM podcasts
      GROUP BY podcast_name
      ORDER BY episodes DESC
    `);

    // Get total available from channels table if exists
    const [channelStats] = await pool.execute(`
      SELECT channel_name, total_videos
      FROM channels
      WHERE channel_name IS NOT NULL
    `);

    const statsMap = new Map(channelStats.map(c => [c.channel_name, c.total_videos]));

    const channelsWithTotal = channels.map(ch => ({
      name: ch.name,
      episodes: ch.episodes,
      total: statsMap.get(ch.name) || ch.episodes,
      last_scan: ch.last_scan
    }));

    res.json({
      total_episodes: totalCount[0].total || 0,
      channels: channelsWithTotal
    });
  } catch (error) {
    console.error('Indexed stats error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Update podcasts endpoint to support pagination
app.get('/api/podcasts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const [rows] = await pool.execute(`
      SELECT id, spotify_url, podcast_name, episode_title, summary, best_part, keywords, processed_at, thumbnail_url
      FROM podcasts
      ORDER BY processed_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    res.json(rows);
  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Supports: YouTube videos, channels, and playlists');
});
