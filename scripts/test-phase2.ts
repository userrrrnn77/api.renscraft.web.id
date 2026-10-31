// scripts/test-phase2.ts
//
// Phase 2 acceptance test (PRD §4.2 + §10 Phase 2):
//   - public-read          → GET 200, POST 403
//   - public-create-only   → POST 201, GET 403
//   - private              → GET 403, POST 403
//   - isolasi tenant: collection nama sama di app berbeda → data tidak bocor
//   - validasi payload: wrong type / unknown field / __proto__ → 400
//   - CORS runtime: Origin * dan tanpa credentials
//
// Regression test untuk bug #2: public-read tidak boleh menerima POST.

import "dotenv/config";
import mongoose from "mongoose";
import { connectToDatabase } from "../src/config/db.js";
import { User } from "../src/models/User.js";
import { Project } from "../src/models/Project.js";
import { DynamicApp } from "../src/models/DynamicApp.js";
import { DynamicCollection } from "../src/models/DynamicCollection.js";
import { DynamicDocument } from "../src/models/DynamicDocument.js";

const BASE_URL = "http://localhost:3000/api";
const RUNTIME_URL = `${BASE_URL}/runtime`;

let failed = 0;
const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failed++;
};

const json = async (res: Response): Promise<any> => {
  try {
    return await res.json();
  } catch {
    return {};
  }
};

async function main() {
  await connectToDatabase();

  const user = await User.findOne({ email: "testing@rensdev.my.id" });
  if (!user)
    throw new Error("User testing gak ada — jalankan test-phase1 dulu");

  const proj = await Project.findOne({ owner: user._id });
  if (!proj) throw new Error("Bikin project dulu — jalankan test-phase1 dulu");

  const stamp = Date.now();
  const slugA = `app-a-${stamp}`;
  const slugB = `app-b-${stamp}`;

  const appA = await DynamicApp.create({
    ownerId: user._id,
    sourceProjectId: proj._id,
    slug: slugA,
    status: "published",
    publishedVersion: 1,
  });
  const appB = await DynamicApp.create({
    ownerId: user._id,
    sourceProjectId: proj._id,
    slug: slugB,
    status: "published",
    publishedVersion: 1,
  });

  // Satu nama dipakai di app A dan app B → untuk uji isolasi tenant.
  const SAME_NAME = "baca";
  const fieldDef = [
    { key: "pesan", label: "Pesan", type: "string" as const, required: true },
  ];

  const colRead = await DynamicCollection.create({
    appId: appA._id,
    name: SAME_NAME,
    label: "Baca A",
    policy: "public-read",
    fields: fieldDef,
  });
  const colWrite = await DynamicCollection.create({
    appId: appA._id,
    name: "tulis",
    label: "Tulis",
    policy: "public-create-only",
    fields: fieldDef,
  });
  const colPrivate = await DynamicCollection.create({
    appId: appA._id,
    name: "rahasia",
    label: "Rahasia",
    policy: "private",
    fields: fieldDef,
  });
  const colBRead = await DynamicCollection.create({
    appId: appB._id,
    name: SAME_NAME,
    label: "Baca B",
    policy: "public-read",
    fields: fieldDef,
  });

  // Seed data langsung via DB (tanpa lewat runtime API)
  await DynamicDocument.create({
    appId: appA._id,
    collectionId: colRead._id,
    data: { pesan: "ini data app A" },
    schemaVersion: colRead.schemaVersion,
  });
  await DynamicDocument.create({
    appId: appB._id,
    collectionId: colBRead._id,
    data: { pesan: "ini data app B" },
    schemaVersion: colBRead.schemaVersion,
  });

  try {
    console.log(`\n📦 appA=${slugA} appB=${slugB}`);
    console.log(`   colRead   = ${colRead.name}  (public-read)`);
    console.log(`   colWrite  = ${colWrite.name}  (public-create-only)`);
    console.log(`   colPrivate= ${colPrivate.name}  (private)`);

    // ─────────────────────────────────────────────────────────────────────
    // TES 1 — create: public-create-only 201, public-read 403, private 403
    // ─────────────────────────────────────────────────────────────────────
    console.log(
      "\n🚀 [TES 1] POST → public-create-only 201, public-read 403, private 403",
    );
    {
      const r1 = await fetch(
        `${RUNTIME_URL}/${slugA}/collections/${colWrite.name}/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pesan: "halo dari create-only" }),
        },
      );
      const b1 = await json(r1);
      ok(
        "create → public-create-only 201",
        r1.status === 201,
        `got ${r1.status}`,
      );
      ok(
        "response berisi id",
        typeof b1.id === "string",
        String(b1.id).slice(0, 40),
      );

      const r2 = await fetch(
        `${RUNTIME_URL}/${slugA}/collections/${colRead.name}/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pesan: "harus ditolak" }),
        },
      );
      ok(
        "create → public-read 403 (bug #2 regression)",
        r2.status === 403,
        `got ${r2.status}`,
      );

      const r3 = await fetch(
        `${RUNTIME_URL}/${slugA}/collections/${colPrivate.name}/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pesan: "harus ditolak" }),
        },
      );
      ok("create → private 403", r3.status === 403, `got ${r3.status}`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // TES 2 — read: public-read 200, public-create-only 403, private 403
    // ─────────────────────────────────────────────────────────────────────
    console.log(
      "\n🚀 [TES 2] GET → public-read 200, public-create-only 403, private 403",
    );
    {
      const r1 = await fetch(
        `${RUNTIME_URL}/${slugA}/collections/${colRead.name}/documents`,
      );
      const b1 = await json(r1);
      ok("GET public-read → 200", r1.status === 200, `got ${r1.status}`);
      ok(
        "data app A: 1 dokumen, isinya milik app A",
        Array.isArray(b1.data) &&
          b1.data.length === 1 &&
          b1.data[0].pesan === "ini data app A",
        JSON.stringify(b1.data?.[0]?.pesan),
      );

      const r2 = await fetch(
        `${RUNTIME_URL}/${slugA}/collections/${colWrite.name}/documents`,
      );
      ok("GET public-create-only → 403", r2.status === 403, `got ${r2.status}`);

      const r3 = await fetch(
        `${RUNTIME_URL}/${slugA}/collections/${colPrivate.name}/documents`,
      );
      ok("GET private → 403", r3.status === 403, `got ${r3.status}`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // TES 3 — isolasi tenant: nama collection sama, app beda, data tidak bocor
    // ─────────────────────────────────────────────────────────────────────
    console.log(
      "\n🚀 [TES 3] Isolasi tenant — nama collection sama, data tidak bocor",
    );
    {
      const rB = await fetch(
        `${RUNTIME_URL}/${slugB}/collections/${SAME_NAME}/documents`,
      );
      const bB = await json(rB);
      ok("app B GET → 200", rB.status === 200, `got ${rB.status}`);
      ok(
        "data app B: 1 dokumen, isinya milik app B (bukan app A)",
        Array.isArray(bB.data) &&
          bB.data.length === 1 &&
          bB.data[0].pesan === "ini data app B",
        JSON.stringify(bB.data?.[0]?.pesan),
      );

      // Slug app B dengan collection yang tidak dimiliki app B → 404
      const rMissing = await fetch(
        `${RUNTIME_URL}/${slugB}/collections/${colWrite.name}/documents`,
      );
      ok(
        "app B akses collection app A → 404",
        rMissing.status === 404,
        `got ${rMissing.status}`,
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // TES 4 — validasi payload: wrong type, __proto__, unknown field → 400
    // ─────────────────────────────────────────────────────────────────────
    console.log(
      "\n🚀 [TES 4] Validasi payload — wrong type / __proto__ / unknown field → 400",
    );
    {
      const badType = await fetch(
        `${RUNTIME_URL}/${slugA}/collections/${colWrite.name}/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pesan: 12345 }),
        },
      );
      ok("wrong type → 400", badType.status === 400, `got ${badType.status}`);

      // __proto__ harus dikirim sebagai raw JSON: `JSON.stringify({__proto__: x})`
      // mengubah prototype, bukan menambah own key, jadi tidak akan pernah
      // sampai ke server. Raw string memastikan JSON.parse membuat own property.
      const proto = await fetch(
        `${RUNTIME_URL}/${slugA}/collections/${colWrite.name}/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"pesan":"ok","__proto__":{"hacked":true}}',
        },
      );
      ok("__proto__ key → 400", proto.status === 400, `got ${proto.status}`);

      const unknown = await fetch(
        `${RUNTIME_URL}/${slugA}/collections/${colWrite.name}/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pesan: "ok", hacker: true }),
        },
      );
      ok(
        "unknown field → 400",
        unknown.status === 400,
        `got ${unknown.status}`,
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // TES 5 — CORS runtime: Origin * dan tanpa credentials
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n🚀 [TES 5] CORS runtime — Origin * tanpa credentials");
    {
      const r = await fetch(
        `${RUNTIME_URL}/${slugA}/collections/${colRead.name}/documents`,
        {
          method: "OPTIONS",
          headers: {
            Origin: "https://example.com",
            "Access-Control-Request-Method": "GET",
          },
        },
      );
      const allowOrigin = r.headers.get("access-control-allow-origin");
      const allowCreds = r.headers.get("access-control-allow-credentials");
      ok(
        "Access-Control-Allow-Origin = *",
        allowOrigin === "*",
        String(allowOrigin),
      );
      ok(
        "Access-Control-Allow-Credentials bukan 'true'",
        allowCreds !== "true",
        String(allowCreds),
      );
    }

    console.log(
      failed === 0
        ? "\n🎉 SEMUA TES FASE 2 BERHASIL!"
        : `\n❌ ${failed} assertion gagal`,
    );
  } finally {
    await DynamicDocument.deleteMany({
      appId: { $in: [appA._id, appB._id] },
    });
    await DynamicCollection.deleteMany({
      appId: { $in: [appA._id, appB._id] },
    });
    await DynamicApp.deleteMany({ _id: { $in: [appA._id, appB._id] } });
    await mongoose.disconnect();
    console.log("👋 cleanup done");
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
