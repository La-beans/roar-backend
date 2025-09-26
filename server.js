import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();


// App setup
const app = express();
app.use(cors({ 
  origin: process.env.CORS_Origin,
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

//set up multer for file uploads
const storage = multer.memoryStorage(); //configure as needed change if better storage is found
const upload = multer({ storage });

// Connect to DB
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  console.log("Auth header:", authHeader, "Token:", token);
  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.error("JWT verification error:", err);
      return res.sendStatus(403);
    }
    req.user = user;
    next();
  });
}

// Get current user info
app.get("/api/me", authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id, email, role FROM users WHERE id = ?", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    const user = rows[0];
    console.log("Fetched user:", user);
    res.json(user); // <-- Return user with role, not tags
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ===== Articles =====
app.get("/api/articles", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT articles.*, authors.name AS author_name
       FROM articles
       LEFT JOIN authors ON articles.author_id = authors.id
       WHERE articles.status = 'published'
       ORDER BY articles.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: "Database query failed" });
  }
});

// ===== Authors =====
app.get("/api/authors", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM authors ORDER BY name ASC");
    res.json(rows);
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: "Database query failed" });
  }
});

// ===== Spotify Links =====
app.get("/api/spotify", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM spotify_links ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: "Database query failed" });
  }
});

// In Server.js
app.get("/api/editor-articles", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, title, status, created_at FROM articles ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Database query failed" });
  }
});

app.delete("/api/articles/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM articles WHERE id = ?", [req.params.id]);
    res.json({ message: "Article deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete article" });
  }
});

app.delete("/api/spotify/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM spotify_links WHERE id = ?", [req.params.id]);
    res.json({ message: "Spotify episode deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete Spotify episode" });
  }
});

// Get one article with its blocks
app.get("/api/articles/:id", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, ab.id AS block_id, ab.block_type, ab.content, ab.position
       FROM articles a
       LEFT JOIN article_blocks ab ON a.id = ab.article_id
       WHERE a.id = ?
       ORDER BY ab.position ASC`,
      [req.params.id]
    );

    if (!rows.length) return res.status(404).json({ error: "Article not found" });

    const article = {
      id: rows[0].id,
      title: rows[0].title,
      author_id: rows[0].author_id,
      status: rows[0].status,
      created_at: rows[0].created_at,
      updated_at: rows[0].updated_at,
      blocks: rows
        .filter(r => r.block_id)
        .map(r => ({
          id: r.block_id,
          block_type: r.block_type,
          content: JSON.parse(r.content || "{}"),
          position: r.position,
        })),
    };

    res.json(article);
  } catch (err) {
    console.error("Error fetching article:", err);
    res.status(500).json({ error: "Failed to fetch article" });
  }
});

// Create new article
app.post("/api/articles", upload.fields([
  { name: "coverImage", maxCount: 1 },
  { name: "pdf", maxCount: 1 }
]), async (req, res) => {
  try {
    const { title, author, date, status } = req.body;
    const coverImage = req.files?.coverImage?.[0]?.filename || null;
    const pdf = req.files?.pdf?.[0]?.filename || null;

    const [result] = await pool.query(
      `INSERT INTO articles (title, author, date, status, coverImage, pdfFile)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [title, author, date, status, coverImage, pdf]
    );

    res.status(201).json({ id: result.insertId, title, author, date, status, coverImage, pdf });
  } catch (err) {
    console.error("Error creating article:", err);
    res.status(500).json({ error: "Failed to create article" });
  }
});

// ===== POST: New Spotify Episode =====
app.post("/api/spotify", async (req, res) => {
  const { title, url, desc, duration, date, videoLink, coverImage, guests } = req.body;
  try {
    const [result] = await pool.query(
      `INSERT INTO spotify_links (title, url, description, duration, episode_date, videoLink, coverImage, guests, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [title, url, desc, duration, date, videoLink, coverImage, guests]
    );
    res.status(201).json({ id: result.insertId, title, url, desc, duration, date, videoLink, coverImage, guests });
  } catch (err) {
    console.error("Error inserting Spotify link:", err);
    res.status(500).json({ error: "Failed to create Spotify entry" });
  }
});

// Add new block to article
app.post("/api/articles/:id/blocks", async (req, res) => {
  const { block_type, content, position } = req.body;

  try {
    const [result] = await pool.query(
      `INSERT INTO article_blocks (article_id, block_type, content, position)
       VALUES (?, ?, ?, ?)`,
      [req.params.id, block_type, JSON.stringify(content), position]
    );

    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error("Error adding block:", err);
    res.status(500).json({ error: "Failed to add block" });
  }
});

// Update article status (draft/review/published)
app.put("/api/articles/:id/status", async (req, res) => {
  const { status } = req.body;

  try {
    await pool.query("UPDATE articles SET status = ? WHERE id = ?", [
      status,
      req.params.id,
    ]);

    res.json({ message: "Status updated", status });
  } catch (err) {
    console.error("Error updating status:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

// ===== LOGIN =====
app.post("/api/login", async (req, res) => {
  console.log("Login attempt:", req.body);
  if (!req.body.email || !req.body.password) {
    return res.status(400).json({ error: "Email and password required" });
  }
  const { email, password } = req.body;
  const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid credentials" });

  // Create JWT (replace 'secret' with env var in production)
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, "secret", { expiresIn: "1h" });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});

// ===== SIGNUP =====
app.post("/api/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  try {
    // Check if user already exists
    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length > 0)
      return res.status(409).json({ error: "Email already registered" });

    // Hash password
    const hash = await bcrypt.hash(password, 10);

    // Insert user with role 'student'
    await pool.query(
      "INSERT INTO users (email, password, role) VALUES (?, ?, 'student')",
      [email, hash]
    );

    res.status(201).json({ message: "Signup successful" });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Start server
app.listen(5000, () => {
  console.log("Backend running at http://localhost:5000");
});
