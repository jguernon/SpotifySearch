-- Database updates for Language Support
-- Run this script AFTER the initial database_update.sql has been applied

-- Add language column to podcasts table
ALTER TABLE podcasts
ADD COLUMN IF NOT EXISTS language VARCHAR(2) DEFAULT 'en';

-- Add language column to keywords table
ALTER TABLE keywords
ADD COLUMN IF NOT EXISTS language VARCHAR(2) DEFAULT 'en';

-- Drop the old unique constraint on keyword (may fail if doesn't exist, that's ok)
-- Run this separately if needed: ALTER TABLE keywords DROP INDEX keyword;

-- Add new unique index on keyword + language combination
-- First check if the old index exists and drop it
SET @exist := (SELECT COUNT(*) FROM information_schema.statistics
               WHERE table_schema = DATABASE()
               AND table_name = 'keywords'
               AND index_name = 'keyword');

SET @sqlstmt := IF(@exist > 0, 'ALTER TABLE keywords DROP INDEX keyword', 'SELECT "Index keyword does not exist"');
PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Now create the new unique index with language
ALTER TABLE keywords ADD UNIQUE INDEX idx_keyword_lang (keyword, language);

-- Add language column to channels table
ALTER TABLE channels
ADD COLUMN IF NOT EXISTS language VARCHAR(2) DEFAULT 'en';

-- Add indexes for language filtering (use IF NOT EXISTS workaround)
-- Note: MySQL doesn't support IF NOT EXISTS for CREATE INDEX, so we ignore errors
CREATE INDEX idx_podcasts_language ON podcasts(language);
CREATE INDEX idx_keywords_language ON keywords(language);

-- ============================================
-- Upload Date Support
-- ============================================

-- Add upload_date column to podcasts table (the actual YouTube video publish date)
ALTER TABLE podcasts
ADD COLUMN IF NOT EXISTS upload_date DATE DEFAULT NULL;

-- Add index for sorting by upload date
CREATE INDEX idx_podcasts_upload_date ON podcasts(upload_date);

-- Add last_video_date to channels table (to track newest video date on YouTube)
ALTER TABLE channels
ADD COLUMN IF NOT EXISTS last_video_date DATE DEFAULT NULL;

-- Add last_checked to channels table (when we last checked for new videos)
ALTER TABLE channels
ADD COLUMN IF NOT EXISTS last_checked DATETIME DEFAULT NULL;

-- ============================================
-- Skipped Videos Tracking
-- ============================================

-- Create table to track videos that were skipped (no subtitles, failed, etc.)
-- This prevents re-processing the same videos over and over
CREATE TABLE IF NOT EXISTS skipped_videos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  video_id VARCHAR(20) NOT NULL UNIQUE,
  video_url VARCHAR(500) NOT NULL,
  channel_name VARCHAR(255),
  video_title VARCHAR(500),
  skip_reason VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_skipped_channel (channel_name),
  INDEX idx_skipped_reason (skip_reason)
);
