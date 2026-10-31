// scripts/test-phase4.ts
//
// Phase 4 acceptance test (PRD §10 Phase 4):
//   1. revisi project tidak mengubah versi live sebelum republish
//   2. app draft / suspended / tidak ada tidak terbuka
//   3. /publish/:name tidak berubah
//
// Requires:
//   - server running on localhost:3000
//   - DYNAMIC_APPS_ENABLED=1
//   - .env with MONGODB_URI and JWT_SECRET
//   - `tsc --noEmit` (or `bun run build`) passes first
//
// Usage (from server/):
//   node --import tsx scripts/test-phase4.ts

import "dotenv/config";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { connectToDatabase } from "../src/config/db.js";
import { User } from "../src/models/User.js";
import { Project } from "../src/models/Project.js";
import { DynamicApp } from "../src/models/DynamicApp.js";
import { DynamicCollection } from "../src/models/DynamicCollection.js";
import { DynamicDocument } from "../src/models/DynamicDocument.js";
import { getJwtSecret } from "../src/config/env.js";

const BASE = "http://localhost:3000";

let failed = 0;
const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failed++;
};

interface Ctx {
  userId: string;
  projectId: string;
  projectName: string;
  userHeaders: { "Content-Type": string; Cookie: string };
  adminHeaders: { "Content-Type": string; Cookie: string };
}

const stamp = Date.now();
const SLUG_MAIN = `t4-main-${stamp}`;
const SLUG_SIDE = `t4-side-${stamp}`;

const json = async (res: Response): Promise<any> => {
  try {
    return await res.json();
  } catch {
    return {};
  }
};

async function setup(): Promise<Ctx> {
  const email = `phase4-test-${stamp}@rensdev.my.id`;
  const user = await User.create({
    name: "Phase4 Test",
    email,
    password: "test-only",
    provider: "local",
    credits: 100,
  });

  const projectName = `phase4-test-${stamp}`;
  const project = await Project.create({
    name: projectName,
    description: "phase 4 test",
    owner: user._id,
    status: "completed",
    version: 1,
    published: true,
    files: {
      "/App.js": {
        content: "export default function App() { return <div>v1</div>; }",
        hash: "h-v1",
      },
    },
  });

  const userToken = jwt.sign(
    { userId: user._id.toString(), email: user.email },
    getJwtSecret(),
    { algorithm: "HS256", expiresIn: "1h" },
  );

  // Admin uses the same JWT_SECRET; the `admin: true` payload is what
  // verifyAdminSession() checks. No admin login needed in the test.
  const adminToken = jwt.sign({ admin: true }, getJwtSecret(), {
    algorithm: "HS256",
    expiresIn: "1h",
  });

  return {
    userId: user._id.toString(),
    projectId: project._id.toString(),
    projectName,
    userHeaders: {
      "Content-Type": "application/json",
      Cookie: `token=${userToken}`,
    },
    adminHeaders: {
      "Content-Type": "application/json",
      Cookie: `admin_token=${adminToken}`,
    },
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  const apps = await DynamicApp.find({ ownerId: ctx.userId })
    .select("_id")
    .lean();
  const ids = apps.map((a) => a._id);
  if (ids.length > 0) {
    await DynamicDocument.deleteMany({ appId: { $in: ids } });
    await DynamicCollection.deleteMany({ appId: { $in: ids } });
  }
  await DynamicApp.deleteMany({ ownerId: ctx.userId });
  await Project.deleteOne({ _id: ctx.projectId });
  await User.deleteOne({ _id: ctx.userId });
}

async function main(): Promise<void> {
  if (process.env.DYNAMIC_APPS_ENABLED !== "1") {
    console.error("Refusing to run: DYNAMIC_APPS_ENABLED != 1");
    process.exit(1);
  }

  console.log("⏳ connecting to DB...");
  await connectToDatabase();
  const ctx = await setup();
  console.log(`👤 user=${ctx.userId} project=${ctx.projectId}\n`);

  let appId = "";
  let publishedVersion = 0;

  try {
    // ─────────────────────────────────────────────────────────────────────
    // T1. draft tidak terbuka
    // ─────────────────────────────────────────────────────────────────────
    console.log("🚀 [T1] app draft → GET /public/:slug 404");
    {
      const res = await fetch(`${BASE}/api/dynamic/apps`, {
        method: "POST",
        headers: ctx.userHeaders,
        body: JSON.stringify({
          sourceProjectId: ctx.projectId,
          slug: SLUG_MAIN,
        }),
      });
      const body = await json(res);
      ok("create app → 201", res.status === 201, `got ${res.status}`);
      ok(
        "status = draft",
        body?.app?.status === "draft",
        String(body?.app?.status),
      );
      appId = String(body?.app?._id ?? "");

      const pub = await fetch(`${BASE}/api/dynamic/public/${SLUG_MAIN}`);
      ok("public draft → 404", pub.status === 404, `got ${pub.status}`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // T2. publish → /public/:slug 200, snapshot berisi file
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🚀 [T2] publish → public 200, snapshot match");
    {
      const res = await fetch(`${BASE}/api/dynamic/apps/${appId}/publish`, {
        method: "POST",
        headers: ctx.userHeaders,
      });
      const body = await json(res);
      ok("publish → 200", res.status === 200, `got ${res.status}`);
      ok("status = published", body?.app?.status === "published");
      ok("publishedVersion = 1", body?.app?.publishedVersion === 1);

      const pub = await fetch(`${BASE}/api/dynamic/public/${SLUG_MAIN}`);
      const pubBody = await json(pub);
      ok("public published → 200", pub.status === 200, `got ${pub.status}`);
      ok(
        "returns slug + version + files",
        pubBody.slug === SLUG_MAIN &&
          typeof pubBody.version === "number" &&
          typeof pubBody.files === "object",
      );
      ok("snapshot has /App.js", "/App.js" in (pubBody.files ?? {}));
      ok(
        "snapshot has /lib/renscraft.js",
        "/lib/renscraft.js" in (pubBody.files ?? {}),
      );
      publishedVersion = pubBody.version as number;
    }

    // ─────────────────────────────────────────────────────────────────────
    // T3. revisi project tidak mengubah versi live sebelum republish
    //     (simulasi revisi via DB — chat AI non-deterministik)
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🚀 [T3] revisi project → snapshot live TIDAK berubah");
    {
      await Project.updateOne(
        { _id: ctx.projectId },
        {
          $set: {
            files: {
              "/App.js": {
                content:
                  "export default function App() { return <div>v2-revised</div>; }",
                hash: "h-v2",
              },
            },
          },
          $inc: { version: 1 },
        },
      );

      const pub = await fetch(`${BASE}/api/dynamic/public/${SLUG_MAIN}`);
      const pubBody = await json(pub);
      ok("public → 200", pub.status === 200);
      ok(
        `version unchanged (still ${publishedVersion})`,
        pubBody.version === publishedVersion,
        `got ${pubBody.version}`,
      );
      const appContent = String(pubBody.files?.["/App.js"]?.content ?? "");
      ok(
        "App.js still v1 (snapshot frozen)",
        appContent.includes("v1") && !appContent.includes("v2"),
        appContent.slice(0, 60),
      );

      const re = await fetch(`${BASE}/api/dynamic/apps/${appId}/publish`, {
        method: "POST",
        headers: ctx.userHeaders,
      });
      const reBody = await json(re);
      ok("republish → 200", re.status === 200);
      ok(
        "publishedVersion bumped",
        reBody?.app?.publishedVersion === publishedVersion + 1,
        `got ${reBody?.app?.publishedVersion}`,
      );

      const pub2 = await fetch(`${BASE}/api/dynamic/public/${SLUG_MAIN}`);
      const pub2Body = await json(pub2);
      const appContent2 = String(pub2Body.files?.["/App.js"]?.content ?? "");
      ok("public now serves v2", appContent2.includes("v2-revised"));
      publishedVersion = pub2Body.version as number;
    }

    // ─────────────────────────────────────────────────────────────────────
    // T4. suspend menutup /public/:slug dan owner tidak bisa unpublish
    // ─────────────────────────────────────────────────────────────────────
    console.log(
      "\n🚀 [T4] suspend → public 404, owner unpublish/republish 403",
    );
    {
      const res = await fetch(`${BASE}/api/admin/dynamic/${appId}/suspend`, {
        method: "POST",
        headers: ctx.adminHeaders,
        body: JSON.stringify({ reason: "phase-4 test" }),
      });
      const body = await json(res);
      ok("suspend → 200", res.status === 200, `got ${res.status}`);
      ok("status = suspended", body?.app?.status === "suspended");

      const pub = await fetch(`${BASE}/api/dynamic/public/${SLUG_MAIN}`);
      ok("public suspended → 404", pub.status === 404, `got ${pub.status}`);

      const unpub = await fetch(`${BASE}/api/dynamic/apps/${appId}/unpublish`, {
        method: "POST",
        headers: ctx.userHeaders,
      });
      ok(
        "owner unpublish suspended → 403",
        unpub.status === 403,
        `got ${unpub.status}`,
      );

      const rep = await fetch(`${BASE}/api/dynamic/apps/${appId}/publish`, {
        method: "POST",
        headers: ctx.userHeaders,
      });
      ok(
        "owner republish suspended → 403",
        rep.status === 403,
        `got ${rep.status}`,
      );

      // Suspend dua kali → 409, bukan 200
      const dup = await fetch(`${BASE}/api/admin/dynamic/${appId}/suspend`, {
        method: "POST",
        headers: ctx.adminHeaders,
      });
      ok("suspend twice → 409", dup.status === 409, `got ${dup.status}`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // T5. restore → draft, publish lagi → published
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🚀 [T5] restore → draft, republish → published");
    {
      const res = await fetch(`${BASE}/api/admin/dynamic/${appId}/restore`, {
        method: "POST",
        headers: ctx.adminHeaders,
      });
      const body = await json(res);
      ok("restore → 200", res.status === 200, `got ${res.status}`);
      ok("status = draft", body?.app?.status === "draft");

      const pub = await fetch(`${BASE}/api/dynamic/public/${SLUG_MAIN}`);
      ok("public draft → 404", pub.status === 404);

      const rep = await fetch(`${BASE}/api/dynamic/apps/${appId}/publish`, {
        method: "POST",
        headers: ctx.userHeaders,
      });
      const repBody = await json(rep);
      ok("owner republish → 200", rep.status === 200);
      ok("status = published", repBody?.app?.status === "published");

      const pub2 = await fetch(`${BASE}/api/dynamic/public/${SLUG_MAIN}`);
      ok("public published → 200", pub2.status === 200);
    }

    // ─────────────────────────────────────────────────────────────────────
    // T6. app tidak ada → 404
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🚀 [T6] app tidak ada → 404");
    {
      const pub = await fetch(
        `${BASE}/api/dynamic/public/this-slug-does-not-exist-${stamp}`,
      );
      ok("public unknown → 404", pub.status === 404, `got ${pub.status}`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // T7. /publish/:name tidak terpengaruh dynamic app
    //     Static publish menyajikan Project.files LIVE (bukan snapshot).
    //     Dynamic publish menyajikan snapshot. Dua-duanya harus jalan.
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🚀 [T7] /publish/:name tidak terpengaruh dynamic app");
    {
      const stat = await fetch(
        `${BASE}/api/projects/public/${encodeURIComponent(ctx.projectName)}`,
      );
      const statBody = await json(stat);
      ok("static publish → 200", stat.status === 200, `got ${stat.status}`);
      const statContent = String(statBody.files?.["/App.js"] ?? "");
      ok(
        "static serves live files (v2)",
        statContent.includes("v2"),
        statContent.slice(0, 60),
      );

      // Buat & publish dynamic app kedua pada project yang sama
      const res = await fetch(`${BASE}/api/dynamic/apps`, {
        method: "POST",
        headers: ctx.userHeaders,
        body: JSON.stringify({
          sourceProjectId: ctx.projectId,
          slug: SLUG_SIDE,
        }),
      });
      const body = await json(res);
      ok("second app → 201", res.status === 201, `got ${res.status}`);
      await fetch(`${BASE}/api/dynamic/apps/${body?.app?._id}/publish`, {
        method: "POST",
        headers: ctx.userHeaders,
      });

      const stat2 = await fetch(
        `${BASE}/api/projects/public/${encodeURIComponent(ctx.projectName)}`,
      );
      const stat2Body = await json(stat2);
      ok("static publish → still 200", stat2.status === 200);
      ok(
        "static publish → still v2",
        String(stat2Body.files?.["/App.js"] ?? "").includes("v2"),
      );
    }

    console.log(
      failed === 0
        ? "\n🎉 PHASE 4 TESTS PASS"
        : `\n❌ ${failed} assertion(s) failed`,
    );
  } finally {
    await teardown(ctx);
    await mongoose.disconnect();
    console.log("👋 cleanup done");
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
