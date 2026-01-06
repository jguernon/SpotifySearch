-- Database updates for Channel Management and Search features
-- Run this script on your MySQL database

-- Add new columns to podcasts table
ALTER TABLE podcasts
ADD COLUMN IF NOT EXISTS keywords TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS ai_processed_at DATETIME DEFAULT NULL;

-- Create channels table for tracking channel stats
CREATE TABLE IF NOT EXISTS channels (
  id INT AUTO_INCREMENT PRIMARY KEY,
  channel_name VARCHAR(255) NOT NULL UNIQUE,
  channel_url VARCHAR(500),
  total_videos INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Create keywords table for search functionality
CREATE TABLE IF NOT EXISTS keywords (
  id INT AUTO_INCREMENT PRIMARY KEY,
  keyword VARCHAR(100) NOT NULL UNIQUE,
  count INT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_keyword (keyword),
  INDEX idx_count (count DESC)
);

-- Add index for faster keyword searches on podcasts
CREATE INDEX IF NOT EXISTS idx_podcasts_keywords ON podcasts(keywords(255));
CREATE INDEX IF NOT EXISTS idx_podcasts_channel ON podcasts(podcast_name);
