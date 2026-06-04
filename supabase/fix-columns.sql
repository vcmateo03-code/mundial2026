-- ============================================================
-- Run this in Supabase SQL Editor to fix column names
-- and ensure RLS insert policy exists
-- ============================================================

-- 1. Rename columns to match what the app sends
--    (skip any that already have the correct name)
DO $$
BEGIN
  -- Rename 'username' to 'name' if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='users' AND column_name='username'
  ) THEN
    ALTER TABLE users RENAME COLUMN username TO name;
  END IF;

  -- Rename 'following_teams' to 'followed_teams' if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='users' AND column_name='following_teams'
  ) THEN
    ALTER TABLE users RENAME COLUMN following_teams TO followed_teams;
  END IF;
END $$;

-- 2. Add group_name column if it doesn't exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS group_name text DEFAULT 'familia';

-- 3. Ensure RLS insert policy exists (drop and recreate to be safe)
DROP POLICY IF EXISTS "users_insert_own" ON users;
CREATE POLICY "users_insert_own" ON users
  FOR INSERT WITH CHECK (true);

-- 4. Ensure RLS select policy exists
DROP POLICY IF EXISTS "users_select_all" ON users;
CREATE POLICY "users_select_all" ON users
  FOR SELECT USING (true);

-- 5. Ensure RLS is enabled
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- 6. Verify final column names
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'users'
ORDER BY ordinal_position;
