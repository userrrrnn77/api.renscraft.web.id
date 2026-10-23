// src/services/email.ts
//
// Nodemailer wrapper for the one thing we email today: the register OTP.
// If SMTP_* is not set, the OTP is logged to the console (dev only).
// In production, an unconfigured SMTP throws — never silently drops the OTP.

import nodemailer, { type Transporter } from "nodemailer";

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
}

let cachedTransporter: Transporter | null = null;
let cachedConfig: SmtpConfig | null = null;

function readConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT) || 465,
    secure: String(process.env.SMTP_SECURE ?? "true") === "true",
    user,
    pass,
    fromName: process.env.SMTP_FROM_NAME?.trim() || "Renscraft",
    fromEmail: process.env.SMTP_FROM_EMAIL?.trim() || user,
  };
}

export function isEmailConfigured(): boolean {
  return readConfig() !== null;
}

function getTransporter(): {
  transporter: Transporter;
  config: SmtpConfig;
} | null {
  const config = readConfig();
  if (!config) return null;

  if (
    !cachedTransporter ||
    !cachedConfig ||
    cachedConfig.host !== config.host ||
    cachedConfig.user !== config.user ||
    cachedConfig.pass !== config.pass
  ) {
    cachedTransporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    cachedConfig = config;
  }

  return { transporter: cachedTransporter, config };
}

interface SendOtpArgs {
  to: string;
  code: string;
  ttlMinutes: number;
}

export async function sendOtpEmail({
  to,
  code,
  ttlMinutes,
}: SendOtpArgs): Promise<void> {
  const sender = getTransporter();

  if (!sender) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Email is not configured (SMTP_*)");
    }
    console.log(
      `[Email] (dev) OTP for ${to}: ${code} (expires in ${ttlMinutes} min)`,
    );
    return;
  }

  const { transporter, config } = sender;
  const spaced = code.split("").join(" ");

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:480px;background:#ffffff;border-radius:12px;border:1px solid #e4e4e7;">
        <tr><td style="padding:32px;">
          <p style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:0.15em;text-transform:uppercase;color:#71717a;">Renscraft</p>
          <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#09090b;">Verifikasi email kamu</h1>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#52525b;">
            Masukkan kode di bawah untuk menyelesaikan pendaftaran. Kode berlaku ${ttlMinutes} menit dan hanya bisa dipakai sekali.
          </p>
          <div style="margin:0 0 24px;padding:20px;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;text-align:center;">
            <p style="margin:0;font-size:28px;font-weight:700;letter-spacing:6px;color:#09090b;font-family:'Courier New',monospace;">${spaced}</p>
          </div>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#52525b;">
            Kalau kamu nggak mendaftar di Renscraft, abaikan email ini. Akun tidak akan dibuat tanpa verifikasi.
          </p>
          <p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #f4f4f5;font-size:12px;color:#a1a1aa;">
            Renscraft — AI Website Builder
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text =
    `Renscraft — Verifikasi email\n\n` +
    `Kode verifikasi: ${code}\n\n` +
    `Kode berlaku ${ttlMinutes} menit dan hanya bisa dipakai sekali.\n\n` +
    `Kalau kamu nggak mendaftar di Renscraft, abaikan email ini.`;

  try {
    await transporter.sendMail({
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to,
      subject: `${code} — Kode verifikasi Renscraft`,
      text,
      html,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Email] Failed to send OTP to ${to}: ${msg}`);
    throw new Error("Could not send the verification email, try again");
  }
}
