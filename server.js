require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
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

// Listen Notes API key (optional, for non-YouTube podcasts)
const LISTEN_NOTES_API_KEY = process.env.LISTEN_NOTES_API_KEY;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Temp directory for audio files
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Detect URL type
function detectUrlType(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    return 'youtube';
  } else if (url.includes('open.spotify.com/episode/')) {
    return 'spotify';
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

// Extract Spotify episode ID
function extractSpotifyId(url) {
  const match = url.match(/episode\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// Download audio from YouTube using yt-dlp
async function downloadFromYoutube(youtubeUrl, outputPath) {
  console.log('Downloading from YouTube with yt-dlp...');

  // Remove extension - yt-dlp adds it
  const outputTemplate = outputPath.replace(/\.[^/.]+$/, '');

  try {
    // Download audio only, convert to mp3, limit to 20 minutes for file size
    const cmd = `yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${outputTemplate}.%(ext)s" --no-playlist "${youtubeUrl}"`;
    console.log('Running:', cmd);

    await execPromise(cmd, { timeout: 600000 }); // 10 min timeout

    // Find the downloaded file
    const expectedPath = `${outputTemplate}.mp3`;
    if (fs.existsSync(expectedPath)) {
      return expectedPath;
    }

    // Check for other formats
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

// Get episode info from Spotify oEmbed API
async function getSpotifyEpisodeInfo(spotifyUrl) {
  return new Promise((resolve, reject) => {
    const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`;

    https.get(oembedUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          resolve({
            title: info.title || 'Unknown Episode',
            provider: info.provider_name || 'Spotify'
          });
        } catch (e) {
          reject(new Error('Failed to parse Spotify info'));
        }
      });
    }).on('error', reject);
  });
}

// Search YouTube for Spotify podcast episode
async function searchYoutubeForPodcast(episodeTitle, podcastName = '') {
  const query = `${episodeTitle} ${podcastName} podcast full episode`.trim();
  console.log('Searching YouTube for:', query);

  try {
    const { stdout } = await execPromise(
      `yt-dlp "ytsearch1:${query}" --dump-json --no-download`,
      { timeout: 30000 }
    );
    const info = JSON.parse(stdout);

    if (info && info.webpage_url) {
      return {
        url: info.webpage_url,
        title: info.title,
        channel: info.uploader || info.channel,
        duration: info.duration
      };
    }
    throw new Error('No results found');
  } catch (error) {
    console.error('YouTube search error:', error.message);
    throw new Error('Could not find podcast on YouTube');
  }
}

// Search for podcast episode on Listen Notes (fallback)
async function searchListenNotes(episodeTitle, podcastName = '') {
  if (!LISTEN_NOTES_API_KEY) {
    throw new Error('Listen Notes API key not configured');
  }

  return new Promise((resolve, reject) => {
    const query = encodeURIComponent(`${episodeTitle} ${podcastName}`.trim());
    const options = {
      hostname: 'listen-api.listennotes.com',
      path: `/api/v2/search?q=${query}&type=episode&len_min=1`,
      method: 'GET',
      headers: {
        'X-ListenAPI-Key': LISTEN_NOTES_API_KEY
      }
    };

    https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.results && result.results.length > 0) {
            const episode = result.results[0];
            resolve({
              audio_url: episode.audio,
              title: episode.title_original,
              podcast_name: episode.podcast?.title_original || 'Unknown Podcast',
              description: episode.description_original,
              audio_length_sec: episode.audio_length_sec
            });
          } else {
            reject(new Error('Episode not found on Listen Notes'));
          }
        } catch (e) {
          reject(new Error('Failed to parse Listen Notes response'));
        }
      });
    }).on('error', reject).end();
  });
}

// Download audio file from URL (for Listen Notes)
async function downloadAudioFromUrl(audioUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = audioUrl.startsWith('https') ? https : http;

    const download = (url, redirectCount = 0) => {
      if (redirectCount > 5) {
        return reject(new Error('Too many redirects'));
      }

      protocol.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to download: HTTP ${res.statusCode}`));
        }

        const file = fs.createWriteStream(outputPath);
        res.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve(outputPath);
        });

        file.on('error', (err) => {
          fs.unlink(outputPath, () => {});
          reject(err);
        });
      }).on('error', reject);
    };

    download(audioUrl);
  });
}

// Convert audio to base64 for Gemini
function audioToBase64(filePath) {
  const audioBuffer = fs.readFileSync(filePath);
  return audioBuffer.toString('base64');
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

// Process podcast - supports YouTube and Spotify URLs
app.post('/api/process', async (req, res) => {
  let audioPath = null;

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const urlType = detectUrlType(url);

    if (urlType === 'unknown') {
      return res.status(400).json({
        error: 'Please provide a valid YouTube or Spotify episode URL'
      });
    }

    // Get unique ID based on URL type
    const episodeId = urlType === 'youtube'
      ? extractYoutubeId(url)
      : extractSpotifyId(url);

    if (!episodeId) {
      return res.status(400).json({ error: 'Could not extract episode ID from URL' });
    }

    // Check if already processed
    const [existing] = await pool.execute(
      'SELECT id FROM podcasts WHERE spotify_url = ?',
      [url]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        error: 'This podcast URL has already been processed',
        exists: true
      });
    }

    let metadata = { title: 'Unknown', podcast_name: 'Unknown' };
    audioPath = path.join(TEMP_DIR, `${episodeId}.mp3`);

    // Process based on URL type
    if (urlType === 'youtube') {
      // Direct YouTube download
      console.log('Processing YouTube URL...');
      const ytInfo = await getYoutubeInfo(url);
      metadata = {
        title: ytInfo.title,
        podcast_name: ytInfo.channel
      };

      await downloadFromYoutube(url, audioPath);

    } else if (urlType === 'spotify') {
      // Spotify: Search on YouTube first, then Listen Notes as fallback
      console.log('Processing Spotify URL...');

      const spotifyInfo = await getSpotifyEpisodeInfo(url).catch(() => ({
        title: 'Unknown',
        provider: 'Spotify'
      }));

      console.log('Spotify episode title:', spotifyInfo.title);

      // Try YouTube search first (works for Joe Rogan and most podcasts)
      let downloadedFromYoutube = false;
      try {
        const ytResult = await searchYoutubeForPodcast(spotifyInfo.title);
        console.log('Found on YouTube:', ytResult.title);

        metadata = {
          title: ytResult.title,
          podcast_name: ytResult.channel
        };

        await downloadFromYoutube(ytResult.url, audioPath);
        downloadedFromYoutube = true;

      } catch (ytError) {
        console.log('YouTube search failed, trying Listen Notes...', ytError.message);
      }

      // Fallback to Listen Notes if YouTube didn't work
      if (!downloadedFromYoutube && LISTEN_NOTES_API_KEY) {
        try {
          const lnResult = await searchListenNotes(spotifyInfo.title);
          console.log('Found on Listen Notes:', lnResult.title);

          metadata = {
            title: lnResult.title,
            podcast_name: lnResult.podcast_name
          };

          await downloadAudioFromUrl(lnResult.audio_url, audioPath);

        } catch (lnError) {
          console.log('Listen Notes also failed:', lnError.message);
          return res.status(404).json({
            error: 'Could not find this podcast episode on YouTube or Listen Notes.',
            suggestion: 'Try providing the YouTube URL directly if you can find the episode there.',
            details: lnError.message
          });
        }
      } else if (!downloadedFromYoutube) {
        return res.status(404).json({
          error: 'Could not find this podcast episode on YouTube.',
          suggestion: 'Try providing the YouTube URL directly if you can find the episode there.'
        });
      }
    }

    // Verify file exists and check size
    if (!fs.existsSync(audioPath)) {
      return res.status(500).json({ error: 'Failed to download audio file' });
    }

    const stats = fs.statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    console.log(`Audio file size: ${fileSizeMB.toFixed(2)} MB`);

    if (fileSizeMB > 20) {
      fs.unlinkSync(audioPath);
      return res.status(413).json({
        error: 'Audio file is too large for processing. Maximum size is 20MB.',
        size: `${fileSizeMB.toFixed(2)} MB`,
        suggestion: 'Try a shorter podcast episode or clip.'
      });
    }

    // Send to Gemini for transcription
    const audioBase64 = audioToBase64(audioPath);
    console.log('Sending audio to Gemini for transcription...');

    const prompt = `Listen to this podcast episode and provide the following in JSON format:
{
  "podcast_name": "The name/title of the podcast series",
  "episode_title": "The title of this specific episode",
  "transcript": "The full transcript of the podcast episode",
  "summary": "A concise 2-3 sentence summary of the episode content",
  "best_part": "The most interesting, insightful, or valuable quote or segment (1-3 sentences, exact quote from the podcast)"
}

Please transcribe the entire audio and analyze its content. If you cannot determine podcast or episode name, use "Unknown".`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: 'audio/mp3',
          data: audioBase64
        }
      }
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
        podcast_name: metadata.podcast_name,
        episode_title: metadata.title,
        transcript: text,
        summary: 'Could not parse summary',
        best_part: 'Could not extract best part'
      };
    }

    // Use metadata as fallback
    if (!analysis.podcast_name || analysis.podcast_name === 'Unknown') {
      analysis.podcast_name = metadata.podcast_name;
    }
    if (!analysis.episode_title || analysis.episode_title === 'Unknown') {
      analysis.episode_title = metadata.title;
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

    // Clean up audio file
    if (audioPath && fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
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

    res.status(500).json({ error: 'Failed to process podcast: ' + error.message });
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Supported URL types: YouTube, Spotify');
});
