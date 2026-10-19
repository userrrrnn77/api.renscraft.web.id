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
} from "../controllers/projectController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { chat } from "../controllers/chatController.js";

const projectRouter = Router();

// Public Route
projectRouter.get("/public/:name", getPublicProject);
projectRouter.get("/public", getAllPublicProjects);

// Protect all following routes
projectRouter.use(authMiddleware);

projectRouter.post("/", createProject);
projectRouter.get("/", listProjects);
projectRouter.get("/:id", getProject);
projectRouter.delete("/:id", deleteProject);
projectRouter.put("/:id/files", updateProjectFiles);
projectRouter.post("/:id/publish", publishProject);

// Image upload: raw body (bukan JSON) biar bisa nerima file binary.
// Limit 6MB — controller yang validasi 5MB, buffer JSON parser default 3mb
// nggak ngefek karena route ini nggak pake express.json().
projectRouter.post(
  "/:id/images",
  express.raw({ type: "image/*", limit: "6mb" }),
  uploadProjectImage,
);
projectRouter.delete("/:id/images", deleteProjectImage);

// Chat
projectRouter.post("/:id/chat", chat);

export default projectRouter;