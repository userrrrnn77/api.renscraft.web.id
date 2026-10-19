// src/controllers/supabaseAuthController.ts

import type { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { User, type AuthProvider } from "../models/User.js";
import { evaluateFreeSignup } from "../services/abuseGuard.js";
import { setSessionCookie } from "./authController.js";
import { fail } from "../utils/apiError.js";

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY?.trim();

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      })
    : null;

type OAuthProvider = Extract<AuthProvider, "google" | "github">;

function isOAuthProvider(value: unknown): value is OAuthProvider {
  return value === "google" || value === "github";
}

function getProviderFromIdentity(
  identities: Array<{ provider?: string }> | null | undefined,
): OAuthProvider | null {
  const providers = new Set((identities ?? []).map((i) => i.provider));
  if (providers.has("google")) return "google";
  if (providers.has("github")) return "github";
  return null;
}

function displayName(user: {
  user_metadata?: Record<string, unknown>;
  email?: string;
}): string {
  const metadata = user.user_metadata ?? {};
  const candidates = [
    metadata.full_name,
    metadata.name,
    metadata.user_name,
    metadata.preferred_username,
  ];
  const name = candidates.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  if (name) return name.trim().slice(0, 100);
  return (user.email?.split("@")[0] || "User").slice(0, 100);
}

export async function createSupabaseSession(req: Request, res: Response) {
  if (!supabase) {
    fail(
      res,
      503,
      "AUTH_SUPABASE_NOT_CONFIGURED",
      {},
      "Supabase authentication is not configured",
    );
    return;
  }

  const accessToken =
    typeof req.body?.accessToken === "string"
      ? req.body.accessToken.trim()
      : "";

  if (!accessToken || accessToken.length > 16_384) {
    fail(
      res,
      400,
      "AUTH_SUPABASE_INVALID_TOKEN",
      {},
      "A valid Supabase accessToken is required",
    );
    return;
  }

  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data.user) {
    fail(
      res,
      401,
      "AUTH_SUPABASE_INVALID_TOKEN",
      {},
      "Supabase session is invalid or expired",
    );
    return;
  }

  const supabaseUser = data.user;
  const provider = getProviderFromIdentity(supabaseUser.identities);

  if (!provider || !isOAuthProvider(provider)) {
    fail(
      res,
      403,
      "AUTH_SUPABASE_OAUTH_ONLY",
      {},
      "Only Google and GitHub OAuth accounts are supported",
    );
    return;
  }

  const email = supabaseUser.email?.trim().toLowerCase();
  if (!email || email.length > 254) {
    fail(
      res,
      400,
      "AUTH_SUPABASE_NO_EMAIL",
      {},
      "Supabase did not provide a usable email address for this account",
    );
    return;
  }

  let user = await User.findOne({ supabaseId: supabaseUser.id });

  if (!user) {
    const emailOwner = await User.findOne({ email }).select("_id provider");
    if (emailOwner) {
      res.status(409).json({
        error:
          "An account already uses this email. Sign in to that account first; automatic account linking is disabled.",
        code: "AUTH_EMAIL_ACCOUNT_EXISTS",
      });
      return;
    }

    const grant = await evaluateFreeSignup(req);

    try {
      user = await User.create({
        name: displayName(supabaseUser),
        email,
        provider,
        supabaseId: supabaseUser.id,
        credits: grant.credits,
        ...(grant.ipHash ? { signupIpHash: grant.ipHash } : {}),
      });
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: number }).code
          : undefined;

      if (code === 11000) {
        user = await User.findOne({ supabaseId: supabaseUser.id });
        if (!user) {
          res.status(409).json({
            error:
              "An account already uses this email. Sign in to that account first; automatic account linking is disabled.",
            code: "AUTH_EMAIL_ACCOUNT_EXISTS",
          });
          return;
        }
      } else {
        throw err;
      }
    }
  } else {
    user.name = displayName(supabaseUser);
    user.provider = provider;
    if (user.email !== email) {
      const emailOwner = await User.findOne({ email }).select("_id");
      if (!emailOwner || emailOwner._id.toString() === user._id.toString()) {
        user.email = email;
      }
    }
    await user.save();
  }

  setSessionCookie(res, {
    userId: user._id.toString(),
    email: user.email,
  });

  res.status(200).json({
    user: {
      _id: user._id,
      name: user.name,
      email: user.email,
      provider: user.provider,
      credits: user.credits ?? 0,
    },
  });
}
