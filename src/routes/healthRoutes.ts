// src/routes/healthRoutes.ts
import { Router } from "express";
import mongoose from "mongoose";

const router = Router();

const PING_TIMEOUT_MS = 2000;

router.get("/", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const ts = new Date().toISOString();
  let dbUp = false;

  if (mongoose.connection.readyState === 1) {
    const db = mongoose.connection.db;
    if (db) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          db.admin().ping(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("ping_timeout")),
              PING_TIMEOUT_MS,
            );
          }),
        ]);
        dbUp = true;
      } catch {
        dbUp = false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  if (dbUp) {
    res.status(200).json({ status: "ok", db: "up", ts });
  } else {
    res.status(503).json({ status: "down", db: "down", ts });
  }
});

export default router;
