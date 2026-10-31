// scripts/test-phase1.ts

import "dotenv/config";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { connectToDatabase } from "../src/config/db.js";
import { User } from "../src/models/User.js";
import { Project } from "../src/models/Project.js";
import { DynamicApp } from "../src/models/DynamicApp.js";
import { DynamicCollection } from "../src/models/DynamicCollection.js";
import { getJwtSecret } from "../src/config/env.js";

const BASE_URL = "http://localhost:3000/api/dynamic";

async function main() {
  console.log("⏳ Menyambung ke database...");
  await connectToDatabase();

  const testEmail = "testing@rensdev.my.id";
  const testPassword = "testing77";

  // 1. Cari atau Bikin Akun Testing
  let user = await User.findOne({ email: testEmail });
  if (!user) {
    console.log("👤 Akun testing belum ada, membuat baru...");
    user = await User.create({
      name: "Testing User",
      email: testEmail,
      password: testPassword,
      provider: "local",
      credits: 100,
    });
  } else {
    console.log("👤 Akun testing ditemukan.");
  }

  // 2. Cari Project yang Completed, atau Bikin Dummy
  let project = await Project.findOne({ owner: user._id, status: "completed" });
  let isDummyProject = false;

  if (!project) {
    console.log("📦 Membuat project dummy (completed) buat testing...");
    project = await Project.create({
      name: "Toko Buket Test",
      description: "Project buat ngetes dynamic app",
      owner: user._id,
      status: "completed",
      files: {
        "/App.js": {
          content: "export default function App() { return <div>Hello</div>; }",
          hash: "123",
        },
      },
    });
    isDummyProject = true;
  } else {
    console.log(
      `📦 Menggunakan project existing: ${project.name} (${project._id})`,
    );
  }

  // 3. Generate JWT Token buat nembak API
  const token = jwt.sign(
    { userId: user._id.toString(), email: user.email },
    getJwtSecret(),
    {
      algorithm: "HS256",
      expiresIn: "1h",
    },
  );
  const headers = {
    "Content-Type": "application/json",
    Cookie: `token=${token}`,
  };

  try {
    // Bersih-bersih DynamicApp sisa tes sebelumnya (biar ga numpuk)
    await DynamicApp.deleteMany({ ownerId: user._id });

    // ─── TES 1: POST /api/dynamic/apps ─────────────────────────────────────
    console.log("\n🚀 [TES 1] Bikin Dynamic App...");
    const slug = `test-app-${Date.now()}`;
    const resApp = await fetch(`${BASE_URL}/apps`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceProjectId: project._id.toString(),
        slug: slug,
      }),
    });

    const dataApp = await resApp.json();
    if (resApp.status !== 201) {
      throw new Error(`Gagal bikin app: ${JSON.stringify(dataApp)}`);
    }
    console.log(
      `✅ App berhasil dibuat! ID: ${dataApp.app._id}, Slug: ${dataApp.app.slug}`,
    );
    const appId = dataApp.app._id;

    // ─── TES 2: POST /api/dynamic/apps/:id/collections ─────────────────────
    console.log("\n🚀 [TES 2] Bikin Collection di dalam App...");
    const resCol = await fetch(`${BASE_URL}/apps/${appId}/collections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "produk",
        label: "Daftar Produk",
        policy: "public-read",
        confirmPublic: true,
        fields: [
          { key: "nama", label: "Nama Produk", type: "string", required: true },
          { key: "harga", label: "Harga", type: "number", required: true },
        ],
      }),
    });

    const dataCol = await resCol.json();
    if (resCol.status !== 201) {
      throw new Error(`Gagal bikin collection: ${JSON.stringify(dataCol)}`);
    }
    console.log(
      `✅ Collection berhasil dibuat! ID: ${dataCol.collection._id}, Name: ${dataCol.collection.name}`,
    );

    // ─── TES 3: Coba Bikin Slug Duplikat (Harusnya Gagal 409) ─────────────
    console.log(
      "\n🚀 [TES 3] Coba bikin App dengan Slug yang sama (Harus Gagal 409)...",
    );
    const resDup = await fetch(`${BASE_URL}/apps`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceProjectId: project._id.toString(),
        slug: slug,
      }),
    });
    const dataDup = await resDup.json();
    if (resDup.status === 409) {
      console.log(`✅ Berhasil ditolak! Code: ${dataDup.code}`);
    } else {
      throw new Error(`Gagal! Seharusnya 409, tapi dapat ${resDup.status}`);
    }

    // ─── TES 4: Coba Bikin Field Terlarang (Harusnya Gagal 400) ───────────
    console.log(
      "\n🚀 [TES 4] Coba bikin Collection dengan Field Terlarang (Harus Gagal 400)...",
    );
    const resBadField = await fetch(`${BASE_URL}/apps/${appId}/collections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "test_bad",
        label: "Bad Fields",
        fields: [{ key: "__proto__", label: "Hacker", type: "string" }],
      }),
    });
    const dataBadField = await resBadField.json();
    if (resBadField.status === 400) {
      console.log(`✅ Berhasil ditolak! Code: ${dataBadField.code}`);
    } else {
      throw new Error(
        `Gagal! Seharusnya 400, tapi dapat ${resBadField.status}`,
      );
    }

    console.log("\n🎉 SEMUA TES FASE 1 BERHASIL!");
  } catch (error) {
    console.error("\n❌ TES GAGAL:", error);
  } finally {
    // 4. Bersih-bersih data tes
    console.log("\n🧹 Membersihkan data Dynamic App sisa testing...");
    await DynamicApp.deleteMany({ ownerId: user._id });

    // Hapus project dummy kalau tadi kita yang bikin
    if (isDummyProject) {
      await Project.deleteOne({ _id: project._id });
    }

    await mongoose.disconnect();
    console.log("👋 Selesai & DB terputus.");
  }
}

main().catch(console.error);
