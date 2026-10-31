// src/services/projectVersions.js
//
// F6: writer snapshot. Dipanggil dari generateProject (commit sukses) dan
// dari chatController (commit revisi sukses). Retention: PROJECT_VERSION_KEEP
// terbaru per project (default 10).
import { ProjectVersion } from "../models/ProjectVersion.js";

const DEFAULT_KEEP = 10;

function keepCount() {
  const n = Number.parseInt(process.env.PROJECT_VERSION_KEEP ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_KEEP;
}

export async function saveProjectVersion({
  projectId,
  version,
  files,
  prompt = null,
  quality = null,
}) {
  try {
    await ProjectVersion.create({
      projectId,
      version,
      files,
      prompt,
      quality,
    });
  } catch (err) {
    // Duplicate = sudah ada. Bukan error.
    if (err?.code === 11000) return;
    throw err;
  }

  // Retention
  const keep = keepCount();
  const excess = await ProjectVersion.find({ projectId })
    .sort({ version: -1 })
    .skip(keep)
    .select("_id")
    .lean();
  if (excess.length > 0) {
    await ProjectVersion.deleteMany({
      _id: { $in: excess.map((x) => x._id) },
    });
  }
}

export async function listProjectVersions(projectId, { limit = 20 } = {}) {
  return ProjectVersion.find({ projectId })
    .sort({ version: -1 })
    .limit(limit)
    .select("-files")
    .lean();
}

export async function getProjectVersion(projectId, version) {
  return ProjectVersion.findOne({ projectId, version }).lean();
}
