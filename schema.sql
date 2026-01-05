-- SpotifySearch Database Schema
-- Run this on your MySQL database: vincis5_spotsearch

CREATE TABLE IF NOT EXISTS podcasts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  spotify_url VARCHAR(500) UNIQUE NOT NULL,
  podcast_name VARCHAR(255),
  episode_title VARCHAR(255),
  transcript LONGTEXT,
  best_part TEXT,
  summary TEXT,
  processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_spotify_url (spotify_url(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
