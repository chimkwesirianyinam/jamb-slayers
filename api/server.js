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
app.use(express.json({ limit: "20kb" }));

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
