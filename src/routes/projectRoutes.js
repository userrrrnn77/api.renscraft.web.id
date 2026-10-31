import express, { Router } from "express";
import {
  createProject,
  deleteProject,
  deleteProjectImage,
  getAllPublicProjects,
  getProject,
  getPublicProject,
  listProjects,
  publishProject,
  updateProjectFiles,
  uploadProjectImage,
  claimSubdomain,
  renewSubdomain,
  releaseSubdomain,
  getPublicProjectBySubdomain,
  exportProject,
  listProjectVersions,
  restoreProjectVersion,
} from "../controllers/projectController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { chat } from "../controllers/chatController.js";

const projectRouter = Router();

// Public Route
projectRouter.get("/public/:name", getPublicProject);
projectRouter.get("/public", getAllPublicProjects);
projectRouter.get("/public/subdomain/:slug", getPublicProjectBySubdomain);

// Protect all following routes
projectRouter.use(authMiddleware);

projectRouter.post("/", createProject);
projectRouter.get("/", listProjects);
projectRouter.get("/:id", getProject);
projectRouter.delete("/:id", deleteProject);
projectRouter.put("/:id/files", updateProjectFiles);
projectRouter.post("/:id/publish", publishProject);

// Subdomain routes
projectRouter.post("/:id/claim-subdomain", claimSubdomain);
projectRouter.post("/:id/renew-subdomain", renewSubdomain);
projectRouter.delete("/:id/subdomain", releaseSubdomain);

// Export route
projectRouter.post("/:id/export", exportProject);
projectRouter.get("/:id/versions", listProjectVersions);
projectRouter.post("/:id/versions/:v/restore", restoreProjectVersion);

// Image upload
projectRouter.post(
  "/:id/images",
  express.raw({ type: "image/*", limit: "6mb" }),
  uploadProjectImage,
);
projectRouter.delete("/:id/images", deleteProjectImage);

// Chat
projectRouter.post("/:id/chat", chat);

export default projectRouter;
