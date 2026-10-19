// scripts/grant-credits.mjs

// scripts/grant-credits.mjs
// Set a user's credit balance by hand (founder / testing / support).
//
//   npx tsx scripts/grant-credits.mjs you@mail.com 500        set balance to 500
//   npx tsx scripts/grant-credits.mjs you@mail.com +100       add 100 to the balance
//
// Reads MONGODB_URI from .env, like the server does. Run it from server/.
import "dotenv/config";
import mongoose from "mongoose";
import { User } from "../src/models/User.ts";

const [email, amountArg] = process.argv.slice(2);
const match = /^([+]?)(\d+)$/.exec(amountArg ?? "");

if (!email || !match) {
  console.error("Usage: npx tsx scripts/grant-credits.mjs <email> <amount | +amount>");
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI is not set (.env)");
  process.exit(1);
}

const amount = Number(match[2]);
const isAdd = match[1] === "+";

await mongoose.connect(process.env.MONGODB_URI);
try {
  // $set / $inc on a missing `credits` field works too (old accounts have none)
  const user = await User.findOneAndUpdate(
    { email: email.toLowerCase().trim() },
    isAdd ? { $inc: { credits: amount } } : { $set: { credits: amount } },
    { returnDocument: "after", projection: { email: 1, credits: 1 } },
  );
  if (!user) {
    console.error(`No user with email ${email}`);
    process.exitCode = 1;
  } else {
    console.log(`${user.email}: ${user.credits} credits`);
  }
} finally {
  await mongoose.disconnect();
}
