// src/server.js
// ... (import sama seperti aslinya)
import express from "express";
import "dotenv/config";
import cors from "cors";
import cookieParser from "cookie-parser";
import { connectToDatabase } from "./config/db.js";
import { getAllowedOrigins, validateEnv } from "./config/env.js";
import appRouter from "./routes/index.routes.js";

try {
  validateEnv();
} catch (err) {
  console.error(`[Config] ${err.message}`);
  process.exit(1);
}

const app = express();

app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS) || 0);

(async () => {
  let delay = 3000;
  let attempt = 1;
  while (true) {
    try {
      await connectToDatabase();
      console.log("[Boot] DB ready.");
      return;
    } catch (err) {
      console.error(
        `[Boot] DB connect attempt ${attempt} failed: ${err.message}. Retry in ${delay / 1000}s.`,
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 60000);
      attempt += 1;
    }
  }
})();

app.use(cors({ origin: getAllowedOrigins(), credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "3mb" }));

app.get("/", (req, res) => {
  res.send("Server is live");
});

app.use("/api", appRouter);

// Centralized error handler
app.use((err, _req, res, _next) => {
  console.error(`[Error] ${err.message}`);
  const status = err.status || err.statusCode || 500;
  // Error tak terduga (DB, library) bisa bawa nama host atau query: log
  // detailnya, tapi jangan bocorin ke client. Client cuma lihat code.
  const message =
    status >= 500 && process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message;
  const code =
    status === 429
      ? "RATE_LIMITED"
      : status >= 500
        ? "INTERNAL_ERROR"
        : "BAD_REQUEST";
  res.status(status).json({ error: message, code });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`server is running at http://localhost:${port}`);
});
