// src/utils/s3.js

// Cloudflare R2 (S3-compatible). Dipakai server untuk menyimpan gambar referensi
// secara permanen: server download -> uploadObject() -> simpan getPublicUrl().
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const bucket = () => process.env.R2_BUCKET || process.env.R2_BUCKET_NAME;

// true kalau semua env R2 sudah diisi (dipakai assetMirror untuk skip dengan rapi)
export const isR2Configured = () =>
  Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      bucket() &&
      process.env.R2_PUBLIC_URL,
  );

// Dibuat lazy (bukan di top-level) supaya env sudah ter-load dan import file ini
// tidak crash di mesin yang belum punya kredensial R2.
let client;
const getClient = () => {
  if (!client) {
    const override = process.env.R2_ENDPOINT; // opsional: untuk tes lokal
    client = new S3Client({
      region: "auto",
      endpoint:
        override ||
        `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      ...(override ? { forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
      // AWS SDK v3 baru menambah header checksum otomatis; R2 tidak selalu
      // menerimanya. "WHEN_REQUIRED" = hanya kirim kalau operasinya mewajibkan.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return client;
};

// Upload langsung dari server (Buffer). Ini yang dipakai alur mirror gambar.
// `client` bisa disuntik untuk tes.
export async function uploadObject(
  objectKey,
  body,
  contentType,
  { cacheControl = "public, max-age=31536000, immutable", client: c } = {},
) {
  try {
    await (c || getClient()).send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: objectKey,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
    return getPublicUrl(objectKey);
  } catch (error) {
    console.error(`[R2] upload failed for ${objectKey}: ${error.message}`);
    throw new Error(`R2 upload failed: ${error.message}`);
  }
}

// Presigned URL untuk upload dari BROWSER (bukan dari server). Belum dipakai
// alur mirror; disimpan untuk fitur upload gambar oleh user.
export async function generateUploadUrl(
  objectKey,
  contentType,
  expiresIn = 300,
) {
  try {
    const command = new PutObjectCommand({
      Bucket: bucket(),
      Key: objectKey,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(getClient(), command, { expiresIn });
    return uploadUrl;
  } catch (error) {
    console.error(`[R2] presign upload failed: ${error.message}`);
    throw new Error("R2 Upload Presigned URL generation failed");
  }
}

// Presigned URL kedaluwarsa (maks 7 hari), JANGAN disimpan di project/website.
// Untuk gambar permanen pakai getPublicUrl().
export async function generateViewUrl(objectKey, expiresIn = 3600) {
  try {
    const command = new GetObjectCommand({
      Bucket: bucket(),
      Key: objectKey,
    });
    return await getSignedUrl(getClient(), command, { expiresIn });
  } catch (error) {
    console.error(`[R2] presign view failed: ${error.message}`);
    throw new Error("R2 View Presigned URL generation failed");
  }
}

// URL permanen. Butuh public access di bucket (r2.dev atau custom domain).
export function getPublicUrl(objectKey) {
  const base = String(process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  return `${base}/${objectKey}`;
}
