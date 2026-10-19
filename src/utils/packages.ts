// src/utils/packages.ts

// The only place that decides what a package costs and how many credits it gives.
// The client only ever sends a packageId: never an amount or a credit count.
//
// Prices were set from `npm run usage:report` (avg AI cost: ~Rp1.6k per generate
// after failure retries, ~Rp0.4k per revision) + Midtrans fee (2.9% + Rp2.000)
// + margin. Target worst-case margin: 60%+ across all tiers.

export interface CreditPackage {
  readonly id: string;
  readonly label: string;
  readonly credits: number;
  // IDR, integer
  readonly amount: number;
}

export const CREDIT_PACKAGES: readonly CreditPackage[] = [
  { id: "starter", label: "Starter", credits: 60, amount: 29000 },
  { id: "plus", label: "Plus", credits: 130, amount: 59000 },
  { id: "pro", label: "Pro", credits: 280, amount: 119000 },
];

export function findPackage(id: unknown): CreditPackage | null {
  if (typeof id !== "string") return null;
  return CREDIT_PACKAGES.find((p) => p.id === id) ?? null;
}
