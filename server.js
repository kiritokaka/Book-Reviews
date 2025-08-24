import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import multer from "multer";
import pkg from "pg";
import fs from "fs";
import * as path from "path";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---- Paths & static
const __dirname = path.resolve();
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use("/uploads", express.static(UPLOADS_DIR, { fallthrough: false, redirect: false }));
app.use(express.static(PUBLIC_DIR));

// ---- DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // nếu dùng Render/Neon có SSL:
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// ---- Upload (multer)
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ---- Helpers
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-this";

function sign(userId) {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: "30d" });
}

function sendUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    address: row.address,
    avatar_url: row.avatar_url,
    created_at: row.created_at,
  };
}

function parseGenres(input) {
  if (!input) return [];
  return input
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
}

// auth middleware
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const m = /^Bearer\s+(.+)/i.exec(h);
    if (!m) return res.status(401).json({ error: "unauthorized" });
    const payload = jwt.verify(m[1], JWT_SECRET);
    req.user = { id: payload.id };
    next();
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
}

// Create notification (like / reply)
async function createNotification({ userId, actorId, type, bookId = null, commentId = null }) {
  if (!userId || userId === actorId) return;
  await pool.query(
    `INSERT INTO notifications (user_id, actor_id, type, book_id, comment_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, actorId, type, bookId, commentId]
  );
}

// ---- AUTH
app.post("/api/auth/register", async (req, res) => {
  const { name, email, address, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "missing_email_or_password" });
  if ((password || "").length < 6) return res.status(400).json({ error: "weak_password" });

  try {
    const ex = await pool.query(`SELECT 1 FROM users WHERE email=$1`, [email]);
    if (ex.rows.length) return res.status(409).json({ error: "email_exists" });

    const hash = await bcrypt.hash(password, 10);
    const q = await pool.query(
      `INSERT INTO users (name, email, address, password_hash, avatar_url)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, email, address, avatar_url, created_at`,
      [name || "", email, address || "", hash, null]
    );
    const user = sendUser(q.rows[0]);
    res.json({ token: sign(user.id), user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "register_failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  try {
    const q = await pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
    const u = q.rows[0];
    if (!u) return res.status(401).json({ error: "invalid_credentials" });
    const ok = await bcrypt.compare(password || "", u.password_hash || "");
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    res.json({ token: sign(u.id), user: sendUser(u) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "login_failed" });
  }
});

app.get("/api/auth/me", auth, async (req, res) => {
  const q = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.user.id]);
  res.json({ user: sendUser(q.rows[0]) });
});

// ---- USERS
app.patch("/api/users/me", auth, upload.single("avatar"), async (req, res) => {
  try {
    const { name, address } = req.body || {};
    const avatar_url = req.file ? `/uploads/${req.file.filename}` : undefined;

    const q = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.user.id]);
    const u = q.rows[0];

    const nq = await pool.query(
      `UPDATE users SET name=$1, address=$2, avatar_url=$3 WHERE id=$4
       RETURNING *`,
      [name ?? u.name, address ?? u.address, avatar_url ?? u.avatar_url, req.user.id]
    );
    res.json({ user: sendUser(nq.rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "update_profile_failed" });
  }
});

app.delete("/api/users/me", auth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM users WHERE id=$1`, [req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "delete_failed" });
  }
});

// ---- GENRES
app.get("/api/genres", async (_, res) => {
  const q = await pool.query(`SELECT DISTINCT unnest(genres) AS g FROM books WHERE genres IS NOT NULL ORDER BY g`);
  res.json({ genres: q.rows.map((r) => r.g).filter(Boolean) });
});

// ---- BOOKS
app.post("/api/books", auth, upload.single("cover"), async (req, res) => {
  try {
    const { title, content, genres, sourceUrl } = req.body;
    if (!title || !content) return res.status(400).json({ error: "missing_title_or_content" });

    const cover_url = req.file ? `/uploads/${req.file.filename}` : null;
    const arrGenres = parseGenres(genres);

    const q = await pool.query(
      `INSERT INTO books (user_id, title, content, genres, cover_url, source_url)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, user_id, title, content, genres, cover_url, source_url, created_at`,
      [req.user.id, title, content, arrGenres, cover_url, sourceUrl || null]
    );
    res.json({ book: q.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "create_book_failed" });
  }
});

app.get("/api/books", async (req, res) => {
  const search = (req.query.search || "").toString();
  const genre = (req.query.genre || "").toString();

  const q = await pool.query(
    `
    SELECT
      b.id, b.title, b.cover_url, b.genres, b.source_url, b.created_at, b.user_id AS author_id,
      u.name AS author_name,
      COALESCE(bl.cnt,0) AS like_count,
      COALESCE(cm.cnt,0) AS comment_count
    FROM books b
    JOIN users u ON u.id = b.user_id
    LEFT JOIN LATERAL (SELECT COUNT(*)::int cnt FROM book_likes l WHERE l.book_id = b.id) bl ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*)::int cnt FROM comments c WHERE c.book_id = b.id) cm ON TRUE
    WHERE ($1 = '' OR b.title ILIKE '%'||$1||'%' OR EXISTS (SELECT 1 FROM unnest(b.genres) g WHERE g ILIKE '%'||$1||'%'))
      AND ($2 = '' OR EXISTS (SELECT 1 FROM unnest(b.genres) g WHERE g ILIKE $2))
    ORDER BY b.created_at DESC
    LIMIT 100
    `,
    [search, genre]
  );

  // ensure arrays
  const books = q.rows.map((r) => ({ ...r, genres: r.genres || [] }));
  res.json({ books });
});

app.get("/api/books/:id", async (req, res) => {
  const id = req.params.id;
  const q = await pool.query(
    `SELECT b.*, u.name AS author_name
     FROM books b JOIN users u ON u.id=b.user_id
     WHERE b.id=$1`,
    [id]
  );
  if (!q.rows.length) return res.status(404).json({ error: "not_found" });
  const book = q.rows[0];
  res.json({ book: { ...book, genres: book.genres || [] } });
});

app.patch("/api/books/:id", auth, upload.single("cover"), async (req, res) => {
  try {
    const id = req.params.id;
    const bq = await pool.query(`SELECT * FROM books WHERE id=$1`, [id]);
    const b = bq.rows[0];
    if (!b) return res.status(404).json({ error: "not_found" });
    if (b.user_id !== req.user.id) return res.status(403).json({ error: "forbidden" });

    const { title, content, genres, sourceUrl } = req.body || {};
    const newCover = req.file ? `/uploads/${req.file.filename}` : undefined;

    const nq = await pool.query(
      `UPDATE books SET
        title=$1, content=$2, genres=$3, source_url=$4, cover_url=$5
       WHERE id=$6 RETURNING *`,
      [
        title ?? b.title,
        content ?? b.content,
        genres !== undefined ? parseGenres(genres) : b.genres,
        sourceUrl ?? b.source_url,
        newCover ?? b.cover_url,
        id,
      ]
    );
    res.json({ book: nq.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "update_book_failed" });
  }
});

app.delete("/api/books/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const bq = await pool.query(`SELECT user_id FROM books WHERE id=$1`, [id]);
    const b = bq.rows[0];
    if (!b) return res.status(404).json({ error: "not_found" });
    if (b.user_id !== req.user.id) return res.status(403).json({ error: "forbidden" });

    await pool.query(`DELETE FROM books WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "delete_book_failed" });
  }
});

// ---- LIKE
app.post("/api/books/:id/like", auth, async (req, res) => {
  const bookId = req.params.id;
  const userId = req.user.id;
  try {
    const bq = await pool.query(`SELECT id, user_id AS author_id FROM books WHERE id=$1`, [bookId]);
    if (!bq.rows.length) return res.status(404).json({ error: "not_found" });

    const cq = await pool.query(`SELECT 1 FROM book_likes WHERE book_id=$1 AND user_id=$2`, [bookId, userId]);
    let liked;
    if (cq.rows.length) {
      await pool.query(`DELETE FROM book_likes WHERE book_id=$1 AND user_id=$2`, [bookId, userId]);
      liked = false;
    } else {
      await pool.query(`INSERT INTO book_likes (book_id, user_id) VALUES ($1,$2)`, [bookId, userId]);
      liked = true;
      await createNotification({ userId: bq.rows[0].author_id, actorId: userId, type: "like", bookId });
    }
    const count = (await pool.query(`SELECT COUNT(*)::int AS c FROM book_likes WHERE book_id=$1`, [bookId])).rows[0].c;
    res.json({ liked, like_count: count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "like_failed" });
  }
});

// ---- COMMENTS (tree + reply)
app.get("/api/books/:id/comments", async (req, res) => {
  const bookId = req.params.id;
  const q = await pool.query(
    `SELECT c.id, c.content, c.parent_id, c.created_at,
            u.id AS author_id, u.name AS author_name, u.avatar_url AS author_avatar
     FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.book_id = $1
     ORDER BY c.created_at ASC`,
    [bookId]
  );
  const list = q.rows;
  const byId = Object.create(null), roots = [];
  list.forEach(n => { n.children = []; byId[n.id] = n; });
  list.forEach(n => (n.parent_id ? byId[n.parent_id]?.children.push(n) : roots.push(n)));
  res.json({ comments: roots });
});

app.post("/api/books/:id/comments", auth, async (req, res) => {
  const { content, parentId } = req.body || {};
  const bookId = req.params.id;
  const userId = req.user.id;
  if (!content?.trim()) return res.status(400).json({ error: "empty_content" });

  try {
    const bq = await pool.query(`SELECT user_id AS author_id FROM books WHERE id=$1`, [bookId]);
    if (!bq.rows.length) return res.status(404).json({ error: "book_not_found" });

    const cq = await pool.query(
      `INSERT INTO comments (book_id, user_id, content, parent_id)
       VALUES ($1,$2,$3,$4)
       RETURNING id, book_id, user_id, content, parent_id, created_at`,
      [bookId, userId, content.trim(), parentId || null]
    );
    const cmt = cq.rows[0];

    if (parentId) {
      const pq = await pool.query(`SELECT user_id FROM comments WHERE id=$1`, [parentId]);
      const parentOwner = pq.rows[0]?.user_id;
      if (parentOwner) {
        await createNotification({ userId: parentOwner, actorId: userId, type: "reply", bookId, commentId: cmt.id });
      }
    } else {
      await createNotification({ userId: bq.rows[0].author_id, actorId: userId, type: "reply", bookId, commentId: cmt.id });
    }

    res.json({ comment: cmt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "comment_failed" });
  }
});

// ---- NOTIFICATIONS
app.get("/api/notifications", auth, async (req, res) => {
  const onlyUnread = req.query.unread === "1";
  const q = await pool.query(
    `SELECT n.id, n.type, n.is_read, n.created_at,
            n.book_id, b.title AS book_title,
            n.comment_id,
            a.name AS actor_name, a.avatar_url AS actor_avatar
     FROM notifications n
     LEFT JOIN books b ON b.id = n.book_id
     JOIN users a ON a.id = n.actor_id
     WHERE n.user_id = $1 AND ($2::boolean IS FALSE OR n.is_read = FALSE)
     ORDER BY n.created_at DESC
     LIMIT 30`,
    [req.user.id, onlyUnread]
  );
  res.json({ notifications: q.rows });
});

app.patch("/api/notifications/:id/read", auth, async (req, res) => {
  await pool.query(`UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.patch("/api/notifications/read-all", auth, async (req, res) => {
  await pool.query(`UPDATE notifications SET is_read=TRUE WHERE user_id=$1`, [req.user.id]);
  res.json({ ok: true });
});

// ---- SPA fallback (optional)
app.get("/", (_, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/book.html", (_, res) => res.sendFile(path.join(PUBLIC_DIR, "book.html")));

// ---- Start
const PORT = process.env.PORT || 3686;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
