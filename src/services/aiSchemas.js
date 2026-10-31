// src/services/aiSchemas.js

import { z } from "zod";

export const GenerationResultSchema = z.object({
  files: z.record(z.string(), z.string()),
  description: z.string().default("Generated project"),
});

export const FileOpSchema = z.object({
  op: z.enum(["create", "update", "delete"]),
  path: z.string(),
  content: z.string().nullable().optional(),
  search: z.string().nullable().optional(),
  replace: z.string().nullable().optional(),
});

export const RevisionResultSchema = z.object({
  operations: z.array(FileOpSchema),
  description: z.string().default("Applied revisions"),
});

export const FilePlanSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      description: z.string(),
      exports: z.string().optional().default(""),
      imports: z.array(z.string()).optional().default([]),
    }),
  ),
  projectName: z.string().default("Generated Project"),
  projectDescription: z.string().default("A React project"),
  imageQueries: z.array(z.string()).optional().default([]),
  facts: z
    .object({
      businessName: z.string().optional(),
      tagline: z.string().optional(),
      city: z.string().optional(),
      address: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      openingHours: z.string().optional(),
      foundedYear: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
  design: z
    .object({
      accent: z.string().max(60).optional(),
      font: z.string().max(60).optional(),
      radius: z.string().max(60).optional(),
    })
    .optional(),
  // ✅ TAMBAHAN FASE 3: Spec Database
  dataSpec: z
    .object({
      collections: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          fields: z.array(
            z.object({
              key: z.string(),
              label: z.string(),
              type: z.enum(["string", "number", "boolean", "date", "select"]),
              required: z.boolean().default(false),
              options: z.array(z.string()).optional(),
            }),
          ),
        }),
      ),
    })
    .optional(),
});

export const FileCodeSchema = z.object({
  code: z.string(),
});

export const ImageReconcileSchema = z.object({
  swaps: z.array(
    z.object({
      path: z.string(),
      from: z.string(),
      to: z.string(),
      reason: z.string().default(""),
    }),
  ),
});
