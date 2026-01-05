require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pool = require('./db');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini AI with the model that supports audio
if (!process.env.GEMINI_API_KEY) {
  console.error('WARNING: GEMINI_API_KEY environment variable is not set');
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Temp directory for audio files
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Extract episode ID from Spotify URL
function extractEpisodeId(url) {
  const match = url.match(/episode\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// Download audio from Spotify using spotdl or yt-dlp
async function downloadSpotifyAudio(spotifyUrl, episodeId) {
  const outputPath = path.join(TEMP_DIR, `${episodeId}.mp3`);

  // Clean up old file if exists
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  try {
    // Try using spotdl first
    console.log('Attempting download with spotdl...');
    await execPromise(`spotdl "${spotifyUrl}" --output "${TEMP_DIR}/{track-id}.mp3"`, { timeout: 300000 });

    // Find the downloaded file
    const files = fs.readdirSync(TEMP_DIR).filter(f => f.endsWith('.mp3'));
    if (files.length > 0) {
      const downloadedFile = path.join(TEMP_DIR, files[0]);
      if (downloadedFile !== outputPath) {
        fs.renameSync(downloadedFile, outputPath);
      }
      return outputPath;
    }
  } catch (spotdlError) {
    console.log('spotdl failed, trying yt-dlp...');

    try {
      // Fallback to yt-dlp with Spotify support
      await execPromise(`yt-dlp -x --audio-format mp3 -o "${outputPath}" "${spotifyUrl}"`, { timeout: 300000 });
      if (fs.existsSync(outputPath)) {
        return outputPath;
      }
    } catch (ytdlpError) {
      console.log('yt-dlp also failed:', ytdlpError.message);
    }
  }

  throw new Error('Could not download podcast audio. Make sure spotdl or yt-dlp is installed.');
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

// Process podcast - download audio, transcribe with Gemini, analyze
app.post('/api/process', async (req, res) => {
  let audioPath = null;

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate Spotify URL
    if (!url.includes('open.spotify.com/episode/')) {
      return res.status(400).json({ error: 'Please provide a valid Spotify episode URL' });
    }

    const episodeId = extractEpisodeId(url);
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

    // Download podcast audio
    console.log('Downloading podcast audio...');
    audioPath = await downloadSpotifyAudio(url, episodeId);
    console.log('Audio downloaded:', audioPath);

    // Convert audio to base64
    const audioBase64 = audioToBase64(audioPath);
    const audioMimeType = 'audio/mp3';

    console.log('Sending audio to Gemini for transcription and analysis...');

    // Send to Gemini for transcription and analysis
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
          mimeType: audioMimeType,
          data: audioBase64
        }
      }
    ]);

    const response = await result.response;
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
        podcast_name: 'Unknown',
        episode_title: 'Unknown',
        transcript: text,
        summary: 'Could not parse summary',
        best_part: 'Could not extract best part'
      };
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

    // Clean up audio file on error
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
});
