-- =====================================================================
--  schema.sql  —  Books App (PostgreSQL)
--  Safe to re-run. Dùng cho nâng cấp DB hiện tại hoặc tạo DB mới.
-- =====================================================================

-- Luôn trỏ schema mặc định
SET search_path TO public;

-- ===== Extensions cần thiết =====
CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;         -- tìm kiếm tiêu đề

-- =====================================================================
-- USERS: tài khoản người dùng
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text          NOT NULL DEFAULT '',
  email         text          NOT NULL UNIQUE,          -- sẽ thêm unique index case-insensitive bên dưới
  address       text,
  avatar_url    text,
  password_hash text,                                   -- để đăng ký/đăng nhập
  created_at    timestamptz  NOT NULL DEFAULT now()
);

-- Bổ sung cột nếu DB cũ chưa có
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url    text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

-- Email unique theo lowercase để tránh trùng hoa/thường
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_indexes
    WHERE  schemaname = 'public'
    AND    indexname  = 'users_email_lower_unique_idx'
  ) THEN
    CREATE UNIQUE INDEX users_email_lower_unique_idx ON users (lower(email));
  END IF;
END $$;

-- =====================================================================
-- BOOKS: bài tóm tắt sách
-- =====================================================================
CREATE TABLE IF NOT EXISTS books (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  content    text NOT NULL,                          -- nội dung tóm tắt
  genres     text[] NOT NULL DEFAULT '{}',           -- thể loại: ['kinh tế','tư duy',...]
  cover_url  text,                                   -- ảnh bìa đã upload (đường dẫn)
  source_url text,                                   -- nguồn link (tùy chọn)
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Bổ sung cột nếu DB cũ chưa có
ALTER TABLE books ADD COLUMN IF NOT EXISTS genres     text[] NOT NULL DEFAULT '{}';
ALTER TABLE books ADD COLUMN IF NOT EXISTS source_url text;

-- Chỉ mục phục vụ tìm kiếm
CREATE INDEX IF NOT EXISTS books_user_idx          ON books(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS books_title_trgm_idx    ON books USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS books_genres_gin_idx    ON books USING gin (genres);

-- =====================================================================
-- COMMENTS: bình luận và trả lời (reply)
-- =====================================================================
CREATE TABLE IF NOT EXISTS comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id    uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    text NOT NULL,
  parent_id  uuid REFERENCES comments(id) ON DELETE CASCADE,  -- null = bình luận gốc
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS comments_book_idx    ON comments(book_id, created_at);
CREATE INDEX IF NOT EXISTS comments_parent_idx  ON comments(parent_id);
CREATE INDEX IF NOT EXISTS comments_user_idx    ON comments(user_id);

-- =====================================================================
-- LIKES: người dùng thích sách
-- =====================================================================
CREATE TABLE IF NOT EXISTS book_likes (
  book_id    uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, user_id)                               -- tránh like trùng
);

CREATE INDEX IF NOT EXISTS book_likes_user_idx ON book_likes(user_id, created_at DESC);

-- =====================================================================
-- NOTIFICATIONS: thông báo (like / reply)
-- =====================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,    -- người nhận thông báo (chủ sách hoặc chủ bình luận)
  actor_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,    -- ai thực hiện hành động (like/reply)
  book_id    uuid REFERENCES books(id) ON DELETE CASCADE,
  comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('like','reply')),
  is_read    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, is_read, created_at DESC);

-- =====================================================================
-- (Tuỳ chọn) VIEW hỗ trợ đếm like nhanh (không bắt buộc)
-- SELECT book_id, count(*) AS likes FROM book_likes GROUP BY book_id;
-- =====================================================================

-- Done.
