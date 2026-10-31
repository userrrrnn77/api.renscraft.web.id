// scripts/test-phase3.ts
import "dotenv/config";
import {
  applyContractToPlan,
  renderContractPrompt,
} from "../src/services/contract/projectContract.js";
import { generateRenstraftSdk } from "../src/services/contract/dynamicSdk.js";
import { resolveScope } from "../src/services/revisionScope.js";
import { buildFilePlanSystem } from "../src/services/prompts.js";

let failed = 0;
const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failed++;
};

// ── 1. Without dataSpec: no SDK file added ─────────────────────────────────
{
  const plan = {
    files: [
      {
        path: "/App.js",
        description: "main",
        exports: "default App",
        imports: [],
      },
      { path: "/styles.css", description: "css", exports: "none", imports: [] },
    ],
    projectName: "Plain",
    projectDescription: "no dataSpec",
  };
  const { contract } = applyContractToPlan(plan, "portfolio biasa");
  const hasSdk = contract.files.some((f) => f.path === "/lib/renscraft.js");
  ok("no dataSpec → no /lib/renscraft.js", !hasSdk);
  ok(
    "no dataSpec → no serverContent SDK",
    contract.files.every((f) => f.path !== "/lib/renscraft.js"),
  );
}

// ── 2. With dataSpec: SDK file injected ────────────────────────────────────
{
  const plan = {
    files: [
      {
        path: "/App.js",
        description: "main",
        exports: "default App",
        imports: [],
      },
      { path: "/styles.css", description: "css", exports: "none", imports: [] },
    ],
    projectName: "WithData",
    projectDescription: "has dataSpec",
    dataSpec: {
      collections: [
        {
          name: "messages",
          label: "Pesan",
          fields: [
            { key: "nama", label: "Nama", type: "string", required: true },
          ],
        },
      ],
    },
  };
  const { contract } = applyContractToPlan(plan, "form kontak");
  const sdk = contract.files.find((f) => f.path === "/lib/renscraft.js");
  ok("dataSpec → /lib/renscraft.js added", !!sdk);
  ok("SDK marked as serverContent", !!sdk?.serverContent);
  ok(
    "SDK exports 'named db'",
    /named\s+db/.test(sdk?.namedExports?.join(",") ?? "") ||
      (sdk?.namedExports ?? []).includes("db"),
  );
  ok(
    "SDK content contains memory adapter",
    (sdk?.serverContent ?? "").includes("memoryDb"),
  );
  ok(
    "SDK content contains db.collection",
    (sdk?.serverContent ?? "").includes("db = {"),
  );
}

// ── 3. generateRenstraftSdk direct ─────────────────────────────────────────
{
  const sdk = generateRenstraftSdk("draft-slug", false);
  ok("SDK has DO NOT EDIT warning", sdk.includes("AUTO-GENERATED"));
  ok("SDK has memory adapter (preview)", sdk.includes("memoryDb"));
  ok(
    "SDK has create/list/get",
    sdk.includes("list:") && sdk.includes("create:") && sdk.includes("get:"),
  );
}

// ── 4. revisionScope excludes SDK ──────────────────────────────────────────
{
  const paths = ["/App.js", "/components/Form.js", "/lib/renscraft.js"];
  const scope = resolveScope("edit /lib/renscraft.js dan Form", paths);
  ok(
    "resolveScope never puts SDK in scope",
    ![...scope.files].includes("/lib/renscraft.js"),
    `scope.files = ${[...scope.files].join(", ") || "(empty)"}`,
  );
}

// ── 5. Prompt: dataSpec block is only mentioned, tidak mengubah base ───────
{
  const legacy = buildFilePlanSystem({ hasBrief: false });
  const withBrief = buildFilePlanSystem({ hasBrief: true });
  ok(
    "legacy prompt DOES mention dataSpec (lihat FILE_PLAN_SYSTEM_BODY)",
    legacy.includes("dataSpec"),
  );
  ok(
    "legacy prompt mentions 'DO NOT plan /lib/renscraft.js'",
    legacy.includes("/lib/renscraft.js"),
  );
  ok("brief prompt also mentions it", withBrief.includes("dataSpec"));
}

// ── 6. renderContractPrompt for SDK consumer file (App.js) ─────────────────
{
  const plan = {
    files: [
      {
        path: "/App.js",
        description: "main",
        exports: "default App",
        imports: [],
      },
      { path: "/styles.css", description: "css", exports: "none", imports: [] },
    ],
    projectName: "X",
    projectDescription: "x",
    dataSpec: { collections: [] },
  };
  const { contract } = applyContractToPlan(plan, "contact form");
  const prompt = renderContractPrompt(contract, "/App.js");
  ok(
    "contract prompt mentions /lib/renscraft.js for App.js",
    prompt.includes("/lib/renscraft.js"),
  );
  ok(
    "contract prompt warns 'do NOT write it'",
    /do NOT write it/i.test(prompt),
  );
}

console.log(
  failed === 0 ? "\n🎉 PHASE 3 UNIT TESTS PASS" : `\n❌ ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
