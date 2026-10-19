// src/models/User.ts

import mongoose, { Schema, type HydratedDocument, type Model } from "mongoose";
import bcrypt from "bcrypt";

// "local" = email + password (our own JWT). "google" / "github" = Supabase
// OAuth login (no password stored here).
export const AUTH_PROVIDERS = ["local", "google", "github"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export interface IUser {
  name: string;
  email: string;
  password?: string;
  provider: AuthProvider;
  // auth.users.id from Supabase, set for google / github accounts
  supabaseId?: string;
  // Spendable balance. Never mutate it with `user.credits -= x; save()`:
  // that races. Use an atomic $inc with a `credits: { $gte: cost }` filter.
  credits: number;
  // HMAC of the signup IP (never the raw IP). Used for abuse checks only.
  signupIpHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface IUserMethods {
  comparePassword(password: string): Promise<boolean>;
}

type UserModel = Model<IUser, Record<string, never>, IUserMethods>;
export type UserDocument = HydratedDocument<IUser, IUserMethods>;

const UserSchema = new Schema<IUser, UserModel, IUserMethods>(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    // Only local accounts have a password
    password: {
      type: String,
      required: [
        function (this: IUser) {
          return this.provider === "local";
        },
        "Password is required for email accounts",
      ],
    },
    provider: {
      type: String,
      enum: AUTH_PROVIDERS,
      default: "local",
      required: true,
    },
    supabaseId: { type: String },
    credits: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: Number.isInteger, message: "credits must be an integer" },
    },
    signupIpHash: { type: String },
  },
  {
    timestamps: true,
    toJSON: {
      // Never send these to the client, even if a controller forgets .select()
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.password;
        delete ret.signupIpHash;
        return ret;
      },
    },
  },
);

// One account per Supabase identity. Sparse: local users have no supabaseId.
UserSchema.index({ supabaseId: 1 }, { unique: true, sparse: true });

// Hash password before saving
UserSchema.pre("save", async function () {
  if (!this.password || !this.isModified("password")) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// OAuth accounts have no password, so they can never log in with one
UserSchema.methods.comparePassword = async function (
  this: UserDocument,
  password: string,
): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(password, this.password);
};

export const User = mongoose.model<IUser, UserModel>("User", UserSchema);
