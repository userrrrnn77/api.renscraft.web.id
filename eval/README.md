# Eval Suite

Per PRD §F0. Folder ini menyimpan kasus evaluasi tetap untuk mengukur
dampak setiap perubahan harness.

## Struktur

- `cases/*.mjs` — satu file per kasus. Default-export async function.
- `results/<git-sha>.json` — output, **di-commit** sebagai baseline.

## Menjalankan

```bash
bun run eval
# atau:
bun run scripts/eval.mjs