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

-- Add indexes for language filtering
CREATE INDEX idx_podcasts_language ON podcasts(language);
CREATE INDEX idx_keywords_language ON keywords(language);
