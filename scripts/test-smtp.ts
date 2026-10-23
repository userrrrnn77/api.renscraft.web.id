// scripts/test-smtp.ts
import "dotenv/config";
import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST!;
const port = Number(process.env.SMTP_PORT) || 465;
const secure = String(process.env.SMTP_SECURE ?? "true") === "true";
const user = process.env.SMTP_USER!;
const pass = process.env.SMTP_PASS!;

console.log("=== SMTP CONFIG ===");
console.log({ host, port, secure, user });
console.log("pass length:", pass?.length);

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: { user, pass },
  logger: true,
  debug: true,
});

try {
  console.log("\n=== VERIFY ===");
  await transporter.verify();
  console.log("✅ VERIFY OK — credentials valid");

  console.log("\n=== SEND TEST ===");
  const info = await transporter.sendMail({
    from: `"Renscraft" <${process.env.SMTP_FROM_EMAIL}>`,
    to: user === "resend" ? "posyandu.chrisna@gmail.com" : user, // Kirim ke email lo
    subject: "SMTP test — Renscraft",
    text: "Kalau lo baca ini, SMTP works.",
  });
  console.log("✅ SENT:", info.messageId);
} catch (err: any) {
  console.error("\n❌ FAILED:", err.message);
}
