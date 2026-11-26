import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pg from "pg";
import admin from "firebase-admin";

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 10000;
const allowedOrigins = new Set([
  "https://jamb-slayers.onrender.com",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
]);

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "5mb" }));

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

let firebaseReady = false;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    firebaseReady = true;
  }
} catch (error) {
  console.error("Firebase Admin configuration is invalid:", error.message);
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please wait and try again." }
});

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}
function validUsername(value) {
  return /^[a-z0-9_]{3,20}$/.test(value);
}
function ready(res) {
  if (!pool || !firebaseReady || !process.env.FIREBASE_WEB_API_KEY) {
    res.status(503).json({ error: "Username sign-in is not configured yet." });
    return false;
  }
  return true;
}
async function verifyBearer(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !firebaseReady) throw new Error("UNAUTHORIZED");
  return admin.auth().verifyIdToken(match[1]);
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    databaseConfigured: Boolean(pool),
    firebaseConfigured: firebaseReady,
    passwordVerificationConfigured: Boolean(process.env.FIREBASE_WEB_API_KEY)
  });
});


const adminEmails = () => new Set(
  String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean)
);
function isAdminAccount(decoded) {
  const email = String(decoded.email || "").trim().toLowerCase();
  return Boolean(email && decoded.email_verified === true && adminEmails().has(email));
}
function unauthorized(res) {
  return res.status(401).json({ error: "Please sign in to continue." });
}
async function ensureMocksTable() {
  if (!pool) throw new Error("DATABASE_NOT_CONFIGURED");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS published_mocks (
      id BIGSERIAL PRIMARY KEY,
      title VARCHAR(120) NOT NULL,
      field VARCHAR(20) NOT NULL CHECK (field IN ('Medical', 'Engineering')),
      questions JSONB NOT NULL,
      created_by_uid VARCHAR(128) NOT NULL,
      created_by_email VARCHAR(320) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS published_mocks_published_at_idx ON published_mocks (published_at DESC)");
}
const validSubjectsByField = {
  Medical: ["English", "Physics", "Chemistry", "Biology"],
  Engineering: ["English", "Mathematics", "Physics", "Chemistry"]
};
function validateMockPayload(body) {
  const title = String(body?.title || "").trim();
  const field = String(body?.field || "");
  const questions = body?.questions;
  if (title.length < 3 || title.length > 120) return "Mock title must be between 3 and 120 characters.";
  if (!validSubjectsByField[field]) return "Choose either Medical or Engineering Field.";
  if (!Array.isArray(questions) || questions.length !== 180) return "A full mock must contain exactly 180 questions.";
  const counts = Object.fromEntries(validSubjectsByField[field].map(subject => [subject, 0]));
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!Array.isArray(q) || q.length !== 6) return `Question ${i + 1} must have exactly six fields.`;
    const [subject, difficulty, prompt, options, correctIndex, explanation] = q;
    if (!Object.hasOwn(counts, subject)) return `Question ${i + 1} has a subject that does not belong to the selected field.`;
    if (!["Easy", "Moderate", "Difficult"].includes(difficulty)) return `Question ${i + 1} has an invalid difficulty.`;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 3000) return `Question ${i + 1} needs a valid question text (maximum 3,000 characters).`;
    if (!Array.isArray(options) || options.length !== 4 || options.some(option => typeof option !== "string" || !option.trim() || option.length > 1000)) return `Question ${i + 1} must have four non-empty options.`;
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) return `Question ${i + 1} has an invalid correct-answer index (use 0–3).`;
    if (typeof explanation !== "string" || !explanation.trim() || explanation.length > 5000) return `Question ${i + 1} needs a detailed explanation (maximum 5,000 characters).`;
    counts[subject]++;
  }
  for (const [subject, count] of Object.entries(counts)) {
    const expected = subject === "English" ? 60 : 40;
    if (count !== expected) return `${subject} must have exactly ${expected} questions; received ${count}.`;
  }
  return null;
}

app.get("/api/mocks/access", async (req, res) => {
  try {
    const decoded = await verifyBearer(req);
    return res.json({ isAdmin: isAdminAccount(decoded), emailVerified: decoded.email_verified === true });
  } catch (error) {
    return unauthorized(res);
  }
});

app.get("/api/mocks", async (req, res) => {
  try {
    await verifyBearer(req);
    await ensureMocksTable();
    const result = await pool.query(
      "SELECT id, title, field, jsonb_array_length(questions) AS question_count, created_at, published_at FROM published_mocks WHERE published_at IS NOT NULL ORDER BY published_at DESC"
    );
    return res.json({ mocks: result.rows });
  } catch (error) {
    if (error.message === "UNAUTHORIZED" || error.code === "auth/id-token-expired" || error.code === "auth/argument-error") return unauthorized(res);
    if (error.message === "DATABASE_NOT_CONFIGURED") return res.status(503).json({ error: "Mock storage is not configured yet." });
    console.error("Could not list published mocks:", error);
    return res.status(500).json({ error: "Published mocks are temporarily unavailable." });
  }
});

app.get("/api/mocks/:id", async (req, res) => {
  try {
    await verifyBearer(req);
    if (!/^\\d+$/.test(req.params.id)) return res.status(400).json({ error: "Invalid mock ID." });
    await ensureMocksTable();
    const result = await pool.query(
      "SELECT id, title, field, questions, created_at, published_at FROM published_mocks WHERE id = $1 AND published_at IS NOT NULL",
      [req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "This mock is no longer available." });
    return res.json({ mock: result.rows[0] });
  } catch (error) {
    if (error.message === "UNAUTHORIZED" || error.code === "auth/id-token-expired" || error.code === "auth/argument-error") return unauthorized(res);
    if (error.message === "DATABASE_NOT_CONFIGURED") return res.status(503).json({ error: "Mock storage is not configured yet." });
    console.error("Could not load published mock:", error);
    return res.status(500).json({ error: "This mock could not be loaded. Please try again." });
  }
});

app.post("/api/mocks", async (req, res) => {
  try {
    const decoded = await verifyBearer(req);
    if (!isAdminAccount(decoded)) {
      return res.status(403).json({ error: "Only an authorised, email-verified administrator can publish mocks." });
    }
    const validationError = validateMockPayload(req.body);
    if (validationError) return res.status(400).json({ error: validationError });
    await ensureMocksTable();
    const title = String(req.body.title).trim();
    const field = String(req.body.field);
    const result = await pool.query(
      "INSERT INTO published_mocks (title, field, questions, created_by_uid, created_by_email) VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id, title, field, created_at, published_at",
      [title, field, JSON.stringify(req.body.questions), decoded.uid, String(decoded.email).toLowerCase()]
    );
    return res.status(201).json({ ok: true, mock: result.rows[0] });
  } catch (error) {
    if (error.message === "UNAUTHORIZED" || error.code === "auth/id-token-expired" || error.code === "auth/argument-error") return unauthorized(res);
    if (error.message === "DATABASE_NOT_CONFIGURED") return res.status(503).json({ error: "Mock storage is not configured yet." });
    console.error("Mock publishing failed:", error);
    return res.status(500).json({ error: "The mock could not be published. Please try again." });
  }
});

app.post("/api/usernames/register", async (req, res) => {
  if (!ready(res)) return;
  try {
    const decoded = await verifyBearer(req);
    const username = normalizeUsername(req.body?.username);
    if (!validUsername(username)) {
      return res.status(400).json({ error: "Username must be 3–20 characters and use only letters, numbers or underscores." });
    }
    if (!decoded.email) {
      return res.status(400).json({ error: "The authenticated account has no email address." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM student_usernames WHERE uid = $1 AND username <> $2", [decoded.uid, username]);
      const result = await client.query(
        `INSERT INTO student_usernames (username, uid, email)
         VALUES ($1, $2, $3)
         ON CONFLICT (username) DO UPDATE
           SET email = EXCLUDED.email, updated_at = NOW()
           WHERE student_usernames.uid = EXCLUDED.uid
         RETURNING username`,
        [username, decoded.uid, decoded.email]
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "That username is already taken. Please choose another." });
      }
      await client.query("COMMIT");
      return res.json({ ok: true, username: result.rows[0].username });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        return res.status(409).json({ error: "This account already has a different username registered." });
      }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error.message === "UNAUTHORIZED" || error.code === "auth/id-token-expired" || error.code === "auth/argument-error") {
      return res.status(401).json({ error: "Please sign in again and retry." });
    }
    console.error("Username registration failed:", error);
    return res.status(500).json({ error: "We could not save your username. Please try again." });
  }
});

app.post("/api/auth/username", authLimiter, async (req, res) => {
  if (!ready(res)) return;
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || "");
  if (!validUsername(username) || !password || password.length > 256) {
    return res.status(400).json({ error: "Enter a valid username and password." });
  }

  try {
    const lookup = await pool.query(
      "SELECT uid, email FROM student_usernames WHERE username = $1 LIMIT 1",
      [username]
    );
    if (!lookup.rowCount) {
      return res.status(401).json({ error: "The username or password is incorrect." });
    }

    const account = lookup.rows[0];
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(process.env.FIREBASE_WEB_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: account.email, password, returnSecureToken: true })
      }
    );
    const verified = await response.json();
    if (!response.ok || verified.localId !== account.uid) {
      return res.status(401).json({ error: "The username or password is incorrect." });
    }

    const customToken = await admin.auth().createCustomToken(account.uid);
    return res.json({ token: customToken });
  } catch (error) {
    console.error("Username sign-in failed:", error);
    return res.status(500).json({ error: "Sign-in is temporarily unavailable. Please try again." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`JAMB Slayers authentication API listening on ${PORT}`);
});
