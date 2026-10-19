// src/services/contract/factsFix.ts
//
// The contract's `facts` (founded year, city) are only a prompt rule, so a file
// can still say "Est. 2024" when the plan says 2018. This module checks the text
// of a generated file against those facts.
//
// It is deliberately conservative. A wrong fix (changing a testimonial's city,
// or "Sejak 2020 kami membuka cabang kedua") is worse than a missed one, so:
//   - a year is changed only next to a founding word, and "since / sejak" only
//     in short label-like text ("Sejak 2018"), never in a longer sentence
//   - a city is changed only in an address line, after a comma
//   - text about a branch / outlet is reported, not edited
//   - everything else that disagrees with the facts is reported, not edited
import * as t from "@babel/types";
import { range, walk, type Edit } from "../../utils/astUtils.js";

export interface FactsFix {
  edits: Edit[];
  fixed: string[];
  open: string[];
}

// ── founded year ────────────────────────────────────────────────────────────

const STRONG_WORDS = /^(didirikan|berdiri|founded|established|est)$/i;
// keyword, optional ".", filler words, year
const FOUNDING_RE =
  /\b(didirikan|berdiri|founded|established|est|since|sejak|dibuka|opened)(?![a-z])(\.?)([\s:,.\-–—]*(?:(?:in|pada|di|tahun|year|since|sejak|the)\s+)*)((?:19|20)\d{2})\b/gi;
const LABEL_MAX = 48;
// A branch, an outlet or a second location has its own year and its own address:
// "Cabang Bandung dibuka 2020", "Jl. Mawar No. 4, Bandung". Text like that is
// reported, never edited.
const BRANCH_RE =
  /\b(cabang|branch(?:es)?|outlet|gerai|lokasi\s+lain|other\s+locations?|kantor\s+pusat|head\s?office)\b/i;

// ── city ────────────────────────────────────────────────────────────────────

const KNOWN_CITIES = [
  "Jakarta",
  "Surabaya",
  "Bandung",
  "Medan",
  "Semarang",
  "Makassar",
  "Palembang",
  "Tangerang",
  "Depok",
  "Bekasi",
  "Bogor",
  "Yogyakarta",
  "Jogja",
  "Jogjakarta",
  "Malang",
  "Batam",
  "Pekanbaru",
  "Bandar Lampung",
  "Padang",
  "Denpasar",
  "Bali",
  "Balikpapan",
  "Samarinda",
  "Banjarmasin",
  "Pontianak",
  "Manado",
  "Solo",
  "Surakarta",
  "Cirebon",
  "Tasikmalaya",
  "Serang",
  "Cimahi",
  "Mataram",
  "Kupang",
  "Jayapura",
  "Ambon",
  "Palu",
  "Kendari",
  "Jambi",
  "Bengkulu",
  "Banda Aceh",
  "Sukabumi",
  "Magelang",
  "Salatiga",
  "Kediri",
  "Madiun",
  "Jember",
  "Purwokerto",
  "Tegal",
  "Pekalongan",
  "Kudus",
  "Sidoarjo",
  "Gresik",
  "Lamongan",
  "Banyuwangi",
];
const CITY_ALIASES: Record<string, string> = {
  jogja: "yogyakarta",
  jogjakarta: "yogyakarta",
  solo: "surakarta",
};
const CITY_ALT = [...KNOWN_CITIES]
  .sort((a, b) => b.length - a.length)
  .map((c) => c.replace(/\s+/g, "\\s+"))
  .join("|");
// ", Surabaya" / ", Kota Surabaya" / ", Kab. Malang"
const ADDRESS_CITY_RE = new RegExp(
  `(,\\s*(?:(?:kota|kab\\.?|kabupaten)\\s+)?)(${CITY_ALT})\\b`,
  "gi",
);
const ANY_CITY_RE = new RegExp(`\\b(${CITY_ALT})\\b`, "gi");
// Jl. / Jalan / Gg. / Kec. / Blok, "No. 12", "RT 03"
const ADDRESS_RE =
  /(?:^|[\s,(])(?:jl|jalan|gg|kec|kel|blok)\.?(?=\s)|\bno\.?\s*\d|\brt\.?\s*\d|\brw\.?\s*\d/i;
const SAFE_CITY = /^[\p{L}][\p{L}\s.\-]*$/u;

const canon = (city: string): string => {
  const c = city.toLowerCase().replace(/\s+/g, " ").trim();
  return CITY_ALIASES[c] ?? c;
};

// "Jakarta" and "Jakarta Selatan" are the same place for this check, "Bali" and
// "Balikpapan" are not: compare whole words, not substrings.
function sameCity(found: string, fact: string): boolean {
  const a = canon(found).split(" ");
  const b = canon(fact).split(" ");
  const within = (small: string[], big: string[]): boolean =>
    big.some((_, i) => small.every((w, j) => big[i + j] === w));
  return within(a, b) || within(b, a);
}

// ── scan ────────────────────────────────────────────────────────────────────

interface TextPiece {
  start: number;
  // source text of the node: this is what the offsets below refer to
  source: string;
  // what the visitor sees on the page, to judge how long the text is
  visible: string;
}

function textPieces(code: string, ast: t.File): TextPiece[] {
  const out: TextPiece[] = [];
  walk(ast.program, (node, parent) => {
    // import / export sources and JSX attribute values are not page text
    if (t.isStringLiteral(node)) {
      if (
        t.isImportDeclaration(parent) ||
        t.isExportNamedDeclaration(parent) ||
        t.isExportAllDeclaration(parent)
      )
        return;
      if (t.isJSXAttribute(parent)) return;
      const r = range(node);
      out.push({
        start: r.start,
        source: code.slice(r.start, r.end),
        visible: node.value,
      });
    } else if (t.isTemplateElement(node)) {
      const r = range(node);
      out.push({
        start: r.start,
        source: code.slice(r.start, r.end),
        visible: node.value.cooked ?? "",
      });
    } else if (t.isJSXText(node)) {
      const r = range(node);
      out.push({
        start: r.start,
        source: code.slice(r.start, r.end),
        visible: node.value,
      });
    }
  });
  return out;
}

export function fixFacts(
  code: string,
  ast: t.File,
  facts: Record<string, string>,
): FactsFix {
  const result: FactsFix = { edits: [], fixed: [], open: [] };
  const year = /^(?:19|20)\d{2}$/.test(facts.foundedYear ?? "")
    ? (facts.foundedYear as string)
    : null;
  const city = facts.city && SAFE_CITY.test(facts.city) ? facts.city : null;
  if (!year && !city) return result;

  const reportedCities = new Set<string>();

  for (const piece of textPieces(code, ast)) {
    const branchy = BRANCH_RE.test(piece.visible);

    // founded year
    if (year) {
      for (const m of piece.source.matchAll(FOUNDING_RE)) {
        const word = m[1] ?? "";
        const found = m[4] ?? "";
        if (found === year) continue;
        if (branchy) {
          result.open.push(
            `"${word} ${found}" next to a branch/outlet, facts say founded ${year}`,
          );
          continue;
        }
        const label = piece.visible.trim().length <= LABEL_MAX;
        if (!STRONG_WORDS.test(word) && !label) {
          result.open.push(
            `"${word} ${found}" in running text, facts say founded ${year}`,
          );
          continue;
        }
        const at = piece.start + (m.index ?? 0) + m[0].length - found.length;
        result.edits.push({ start: at, end: at + found.length, text: year });
        result.fixed.push(`founded year ${found} -> ${year} (facts)`);
      }
    }

    // city
    if (city) {
      const isAddress = ADDRESS_RE.test(piece.visible) && !branchy;
      if (isAddress) {
        for (const m of piece.source.matchAll(ADDRESS_CITY_RE)) {
          const found = (m[2] ?? "").replace(/\s+/g, " ");
          if (sameCity(found, city)) continue;
          const at = piece.start + (m.index ?? 0) + (m[1] ?? "").length;
          const end = at + (m[2] ?? "").length;
          const text =
            found === found.toUpperCase() ? city.toUpperCase() : city;
          result.edits.push({ start: at, end, text });
          result.fixed.push(`address city ${found} -> ${city} (facts)`);
        }
      }
      for (const m of piece.source.matchAll(ANY_CITY_RE)) {
        const found = (m[1] ?? "").replace(/\s+/g, " ");
        if (sameCity(found, city)) continue;
        const handled =
          isAddress &&
          result.edits.some(
            (e) =>
              e.start >= piece.start &&
              e.start < piece.start + piece.source.length,
          );
        if (handled) continue;
        const key = canon(found);
        if (reportedCities.has(key)) continue;
        reportedCities.add(key);
        result.open.push(`mentions ${found}, facts say the city is ${city}`);
      }
    }
  }
  return result;
}
