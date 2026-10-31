// src/services/budget.js
//
// F4: per-project generation budget. Counter hidup di AsyncLocalStorage store
// yang sudah dipakai usageTracker.js, jadi nggak perlu parameter tambahan.
//
// Mode:
//   "log"     → counter jalan, TIDAK throw. Rollout awal.
//   "enforce" → throw BudgetExceededError saat limit tercapai.

const DEFAULT_MAX_CALLS = 40;
const DEFAULT_MAX_INPUT_TOKENS = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 100_000;

export class BudgetExceededError extends Error {
  constructor(resource, current, max) {
    super(`BUDGET_EXCEEDED: ${resource} (${current}/${max})`);
    this.name = "BudgetExceededError";
    this.code = "BUDGET_EXCEEDED";
    this.resource = resource;
    this.current = current;
    this.max = max;
  }
}

function positiveInt(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createBudgetConfig(env = process.env) {
  const mode = String(env.HARNESS_BUDGET ?? "log").toLowerCase();
  return {
    mode: mode === "enforce" ? "enforce" : "log",
    maxCalls: positiveInt(env.GEN_BUDGET_MAX_CALLS, DEFAULT_MAX_CALLS),
    maxInputTokens: positiveInt(
      env.GEN_BUDGET_MAX_INPUT_TOKENS,
      DEFAULT_MAX_INPUT_TOKENS,
    ),
    maxOutputTokens: positiveInt(
      env.GEN_BUDGET_MAX_OUTPUT_TOKENS,
      DEFAULT_MAX_OUTPUT_TOKENS,
    ),
  };
}

export function initBudget(store, env = process.env) {
  if (!store) return;
  store.budget = {
    ...createBudgetConfig(env),
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

export function assertBudget(store, label = "") {
  if (!store?.budget) return;
  const b = store.budget;
  if (b.mode !== "enforce") return;

  if (b.calls >= b.maxCalls) {
    throw new BudgetExceededError("maxCalls", b.calls, b.maxCalls);
  }
  if (b.inputTokens >= b.maxInputTokens) {
    throw new BudgetExceededError(
      "maxInputTokens",
      b.inputTokens,
      b.maxInputTokens,
    );
  }
  if (b.outputTokens >= b.maxOutputTokens) {
    throw new BudgetExceededError(
      "maxOutputTokens",
      b.outputTokens,
      b.maxOutputTokens,
    );
  }
}

export function recordBudget(store, usage) {
  if (!store?.budget) return;
  const b = store.budget;
  b.calls += 1;
  b.inputTokens += Number(usage?.inputTokens) || 0;
  b.outputTokens += Number(usage?.outputTokens) || 0;
}

export function budgetSummary(store) {
  if (!store?.budget) return null;
  const b = store.budget;
  const exceeded =
    b.calls >= b.maxCalls ||
    b.inputTokens >= b.maxInputTokens ||
    b.outputTokens >= b.maxOutputTokens;
  return {
    mode: b.mode,
    exceeded,
    calls: b.calls,
    maxCalls: b.maxCalls,
    inputTokens: b.inputTokens,
    maxInputTokens: b.maxInputTokens,
    outputTokens: b.outputTokens,
    maxOutputTokens: b.maxOutputTokens,
  };
}
