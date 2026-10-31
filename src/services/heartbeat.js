// src/services/heartbeat.js
//
// Sentuh updatedAt selama fase panjang (planning, fact guard, gate, repair)
// supaya settleIfStale() nggak salah menandai project yang masih hidup.
import { Project } from "../models/Project.js";

const BUSY = ["pending", "generating", "revising"];

export function createHeartbeat(projectId, intervalMs = 30_000) {
  let timer = null;
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        Project.updateOne(
          { _id: projectId, status: { $in: BUSY } },
          { $set: { updatedAt: new Date() } },
        ).catch(() => {
          // heartbeat best-effort: kegagalan tidak boleh mematikan proses
        });
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
