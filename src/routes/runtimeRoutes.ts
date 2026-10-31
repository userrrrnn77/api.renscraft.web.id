// src/routes/runtimeRoutes.ts
import { Router } from "express";
import cors from "cors";
import { isDynamicAppsEnabled } from "../config/env.js";
import { fail } from "../utils/apiError.js";
import {
  createDocument,
  getDocument,
  listDocuments,
} from "../controllers/runtimeController.js";
import { dynamicRuntimeRateLimit } from "../middleware/runtimeRateLimit.js";

const router = Router();

// CORS KHUSUS RUNTIME: Origin *, TANPA credentials!
router.use(cors({ origin: "*", credentials: false }));

router.use((req, res, next) => {
  if (!isDynamicAppsEnabled())
    return fail(res, 503, "DYNAMIC_APPS_DISABLED", {}, "Disabled");
  next();
});

// Rate Limit
router.use(dynamicRuntimeRateLimit);

// Path: /api/runtime/:slug/collections/:name/documents
router.post("/:slug/collections/:name/documents", createDocument);
router.get("/:slug/collections/:name/documents", listDocuments);
router.get("/:slug/collections/:name/documents/:id", getDocument);

export default router;
