// FILE: src/services/brief/vibePresets.js

import { VIBE_HINTS } from "./slotCatalog.js";

export const VIBE_PRESETS = {
  "Modern minimalis": {
    hint: VIBE_HINTS["Modern minimalis"],
    tokens: {
      bg: "#FAFAF8",
      surface: "#FFFFFF",
      ink: "#16181D",
      muted: "#5B616B",
      line: "#E4E4DF",
      accent: "#0B5FFF",
      accentInk: "#FFFFFF",
    },
    dark: {
      bg: "#0B0D12",
      surface: "#141821",
      ink: "#F5F7FA",
      muted: "#A7B0BD",
      line: "#2A303B",
      accent: "#5B8CFF",
      accentInk: "#08111F",
    },
    fonts: {
      display: {
        family: "Instrument Sans",
        weights: "400;500;600;700",
        kind: "sans-serif",
      },
      body: {
        family: "Instrument Sans",
        weights: "400;500;600;700",
        kind: "sans-serif",
      },
    },
    radius: "rounded-lg",
    border: "border",
    shadow: "shadow-none",
    avoid: [
      "dekorasi berlebih",
      "lebih dari satu warna aksen",
      "shadow tebal",
      "font dekoratif",
      "gradient ramai",
    ],
    note: "",
  },

  "Vintage / hangat": {
    hint: VIBE_HINTS["Vintage / hangat"],
    tokens: {
      bg: "#F3E9D7",
      surface: "#FBF5E8",
      ink: "#3B2A1E",
      muted: "#6A5440",
      line: "#D9C7A8",
      accent: "#9C3B2B",
      accentInk: "#FFF8EE",
    },
    dark: {
      bg: "#17120E",
      surface: "#211A14",
      ink: "#F2E7D8",
      muted: "#C7B49A",
      line: "#4A3B2C",
      accent: "#E08A6F",
      accentInk: "#1A0F0A",
    },
    fonts: {
      display: { family: "Fraunces", weights: "400;600;700", kind: "serif" },
      body: { family: "Work Sans", weights: "400;500;600", kind: "sans-serif" },
    },
    radius: "rounded-sm",
    border: "border",
    shadow: "shadow-none",
    avoid: [
      "palet neon",
      "sudut sangat rounded",
      "shadow keras",
      "font sans-serif modern default",
      "warna dingin",
    ],
    note: "",
  },

  "Playful & berwarna": {
    hint: VIBE_HINTS["Playful & berwarna"],
    tokens: {
      bg: "#FFFBF0",
      surface: "#FFFFFF",
      ink: "#1B1340",
      muted: "#55507A",
      line: "#D9D2EE",
      accent: "#FF4F8B",
      accentInk: "#1B1340",
      accent2: "#2DD4BF",
    },
    dark: {
      bg: "#141026",
      surface: "#1E1838",
      ink: "#F7F2FF",
      muted: "#B8AEDB",
      line: "#3A315E",
      accent: "#FF7AA8",
      accentInk: "#24102A",
    },
    fonts: {
      display: {
        family: "Fredoka",
        weights: "400;500;600;700",
        kind: "sans-serif",
      },
      body: { family: "Nunito", weights: "400;600;700", kind: "sans-serif" },
    },
    radius: "rounded-3xl",
    border: "border-2",
    shadow: "shadow-[0_6px_0_rgba(27,19,64,0.15)]",
    avoid: [
      "palet gelap",
      "whitespace kaku ala korporat",
      "border tebal keras",
      "font serif klasik",
      "shadow keras",
    ],
    note: "",
  },

  "Elegan / mewah": {
    hint: VIBE_HINTS["Elegan / mewah"],
    tokens: {
      bg: "#0F0E0C",
      surface: "#1A1815",
      ink: "#F2EBDD",
      muted: "#A89F8D",
      line: "#3A352C",
      accent: "#C9A24B",
      accentInk: "#0F0E0C",
    },
    dark: null,
    fonts: {
      display: {
        family: "Cormorant Garamond",
        weights: "400;500;600;700",
        kind: "serif",
      },
      body: { family: "Jost", weights: "400;500;600", kind: "sans-serif" },
    },
    radius: "rounded-none",
    border: "border",
    shadow: "shadow-none",
    avoid: [
      "warna neon",
      "rounded besar",
      "shadow tebal",
      "font sans-serif default",
      "layout padat",
    ],
    note: "letter-spacing lebar, spasi sangat lega.",
  },

  "Gelap & techy": {
    hint: VIBE_HINTS["Gelap & techy"],
    tokens: {
      bg: "#07090D",
      surface: "#0E1218",
      ink: "#E6EDF3",
      muted: "#8B98A5",
      line: "#1E2733",
      accent: "#2EE6A6",
      accentInk: "#04130D",
    },
    dark: null,
    fonts: {
      display: {
        family: "IBM Plex Sans",
        weights: "400;500;600;700",
        kind: "sans-serif",
      },
      body: {
        family: "IBM Plex Sans",
        weights: "400;500;600;700",
        kind: "sans-serif",
      },
      code: { family: "IBM Plex Mono", weights: "400;500", kind: "monospace" },
    },
    radius: "rounded-md",
    border: "border",
    shadow: "shadow-[0_0_24px_rgba(46,230,166,0.15)]",
    avoid: [
      "background terang",
      "warna pastel",
      "font serif",
      "rounded besar",
      "shadow lembut",
    ],
    note: "font code untuk label kecil dan data.",
  },

  "Glassmorphism / kaca blur": {
    hint: VIBE_HINTS["Glassmorphism / kaca blur"],
    tokens: {
      bg: "#101826",
      bgImage:
        "radial-gradient(48rem 36rem at 8% 0%, rgba(255,107,107,0.55), transparent 60%), radial-gradient(44rem 34rem at 100% 100%, rgba(46,196,182,0.5), transparent 55%)",
      surface: "rgba(255,255,255,0.10)",
      ink: "#F8FAFC",
      muted: "#CBD5E1",
      line: "rgba(255,255,255,0.20)",
      accent: "#FFD166",
      accentInk: "#101826",
    },
    dark: null,
    fonts: {
      display: {
        family: "Manrope",
        weights: "400;500;600;700;800",
        kind: "sans-serif",
      },
      body: {
        family: "Manrope",
        weights: "400;500;600;700;800",
        kind: "sans-serif",
      },
    },
    radius: "rounded-2xl",
    border: "border",
    shadow: "shadow-[0_8px_32px_rgba(0,0,0,0.25)]",
    avoid: [
      "panel tanpa background berwarna",
      "bg opaque penuh",
      "border tebal gelap",
      "font default Inter",
      "shadow keras",
    ],
    note: "panel pakai backdrop-blur-xl.",
  },

  "Claymorphism / 3D lembut": {
    hint: VIBE_HINTS["Claymorphism / 3D lembut"],
    tokens: {
      bg: "#FFF3E4",
      surface: "#FFFFFF",
      ink: "#2F2A45",
      muted: "#625C80",
      line: "rgba(47,42,69,0.08)",
      accent: "#FF8A5B",
      accentInk: "#2F2A45",
      accent2: "#7ED6C1",
    },
    dark: {
      bg: "#1C1828",
      surface: "#262138",
      ink: "#F5F1FF",
      muted: "#B9B0D0",
      line: "rgba(245,241,255,0.12)",
      accent: "#FFA07A",
      accentInk: "#2A1A18",
    },
    fonts: {
      display: {
        family: "Baloo 2",
        weights: "400;500;600;700;800",
        kind: "sans-serif",
      },
      body: { family: "Nunito", weights: "400;600;700", kind: "sans-serif" },
    },
    radius: "rounded-3xl",
    border: "border",
    shadow:
      "shadow-[8px_8px_0_rgba(47,42,69,0.12),inset_-4px_-4px_8px_rgba(0,0,0,0.06),inset_4px_4px_8px_rgba(255,255,255,0.9)]",
    avoid: [
      "sudut tajam",
      "shadow datar",
      "palet gelap",
      "border keras",
      "font tipis",
    ],
    note: "",
  },

  "Brutalism / tebal & mentah": {
    hint: VIBE_HINTS["Brutalism / tebal & mentah"],
    tokens: {
      bg: "#F4F1E8",
      surface: "#FFFFFF",
      ink: "#0A0A0A",
      muted: "#333333",
      line: "#0A0A0A",
      accent: "#FF4D2E",
      accentInk: "#0A0A0A",
      accent2: "#FFD400",
    },
    dark: {
      bg: "#0D0D0D",
      surface: "#161616",
      ink: "#F5F5F0",
      muted: "#BDBDB5",
      line: "#F5F5F0",
      accent: "#FF6B4A",
      accentInk: "#0A0A0A",
    },
    fonts: {
      display: { family: "Archivo Black", weights: "400", kind: "sans-serif" },
      body: {
        family: "IBM Plex Mono",
        weights: "400;500;600",
        kind: "monospace",
      },
    },
    radius: "rounded-none",
    border: "border-4",
    shadow: "shadow-[6px_6px_0_#000]",
    avoid: [
      "rounded-*",
      "shadow-sm",
      "font Inter",
      "gradient lembut",
      "border-zinc-100",
      "warna pastel",
    ],
    note: "",
  },

  "Neomorphism / timbul lembut": {
    hint: VIBE_HINTS["Neomorphism / timbul lembut"],
    tokens: {
      bg: "#E0E5EC",
      surface: "#E0E5EC",
      ink: "#2D3748",
      muted: "#4A5568",
      line: "transparent",
      accent: "#2F6FED",
      accentInk: "#FFFFFF",
    },
    dark: {
      bg: "#1A1F27",
      surface: "#1A1F27",
      ink: "#E6EBF2",
      muted: "#AAB4C3",
      line: "transparent",
      accent: "#6EA0FF",
      accentInk: "#07101F",
    },
    fonts: {
      display: {
        family: "Manrope",
        weights: "400;500;600;700;800",
        kind: "sans-serif",
      },
      body: {
        family: "Manrope",
        weights: "400;500;600;700;800",
        kind: "sans-serif",
      },
    },
    radius: "rounded-3xl",
    border: "border-0",
    shadow: "shadow-[9px_9px_16px_#a3b1c6,-9px_-9px_16px_#ffffff]",
    avoid: [
      "border tebal",
      "shadow keras",
      "palet kontras tinggi",
      "gradient ramai",
      "font dekoratif",
    ],
    note: "",
  },

  "Skeuomorphism / realistis": {
    hint: VIBE_HINTS["Skeuomorphism / realistis"],
    tokens: {
      bg: "#CFC8B8",
      surface: "#E9E3D3",
      ink: "#2B2118",
      muted: "#51453A",
      line: "#8C8272",
      accent: "#B3541E",
      accentInk: "#FFF6EA",
    },
    dark: {
      bg: "#1B1712",
      surface: "#262019",
      ink: "#F1E8DA",
      muted: "#C0B29E",
      line: "#5A4E3E",
      accent: "#D97A3D",
      accentInk: "#1B0F08",
    },
    fonts: {
      display: { family: "Bitter", weights: "400;600;700", kind: "serif" },
      body: {
        family: "Source Sans 3",
        weights: "400;600;700",
        kind: "sans-serif",
      },
    },
    radius: "rounded-xl",
    border: "border",
    shadow:
      "shadow-[0_1px_0_#fff_inset,0_2px_4px_rgba(0,0,0,0.25),0_8px_16px_rgba(0,0,0,0.15)]",
    avoid: [
      "flat design",
      "shadow datar",
      "palet neon",
      "sudut tajam",
      "font mono",
    ],
    note: "gradient multi-stop dan bevel diperbolehkan.",
  },

  "Maximalism / ramai penuh": {
    hint: VIBE_HINTS["Maximalism / ramai penuh"],
    tokens: {
      bg: "#FFF4D6",
      surface: "#FFFFFF",
      ink: "#1A0B2E",
      muted: "#3D2B56",
      line: "#1A0B2E",
      accent: "#FF2E93",
      accentInk: "#1A0B2E",
      accent2: "#00B3FF",
      accent3: "#7A3CFF",
    },
    dark: {
      bg: "#160A26",
      surface: "#21103A",
      ink: "#FFF7E8",
      muted: "#C9B8E6",
      line: "#6B4AA0",
      accent: "#FF5FA8",
      accentInk: "#1A0B2E",
    },
    fonts: {
      display: {
        family: "Syne",
        weights: "400;600;700;800",
        kind: "sans-serif",
      },
      body: {
        family: "Archivo",
        weights: "400;500;600;700",
        kind: "sans-serif",
      },
    },
    radius: "rounded-2xl",
    border: "border-2",
    shadow: "shadow-[5px_5px_0_#1A0B2E]",
    avoid: [
      "whitespace lega ala minimalis",
      "palet zinc/netral",
      "satu warna aksen",
      "layout kosong",
      "font tipis",
    ],
    note: "",
  },
};

export const CATEGORY_DEFAULT_PRESETS = {
  kuliner: ["Vintage / hangat", "Playful & berwarna", "Modern minimalis"],
  portfolio: ["Modern minimalis", "Brutalism / tebal & mentah"],
  jasa: ["Modern minimalis", "Claymorphism / 3D lembut"],
  event: ["Vintage / hangat", "Playful & berwarna", "Maximalism / ramai penuh"],
  artikel: ["Modern minimalis", "Vintage / hangat"],
  brosur: ["Modern minimalis", "Maximalism / ramai penuh"],
  toko_produk: [
    "Playful & berwarna",
    "Modern minimalis",
    "Claymorphism / 3D lembut",
  ],
  app_tool: [
    "Neomorphism / timbul lembut",
    "Playful & berwarna",
    "Modern minimalis",
  ],
  dashboard: ["Modern minimalis", "Neomorphism / timbul lembut"],
  lainnya: ["Modern minimalis", "Vintage / hangat"],
};

function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function designFromBrief(snapshot, prompt) {
  try {
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      Object.keys(snapshot).length === 0
    ) {
      return null;
    }

    const vibeValue = snapshot.answers?.vibe?.value;
    const vibe =
      typeof vibeValue === "string" ? vibeValue.trim().toLowerCase() : "";

    let id = null;
    let source = null;

    if (vibe) {
      id =
        Object.keys(VIBE_PRESETS).find((key) => key.toLowerCase() === vibe) ??
        null;
      if (id) source = "vibe";
    }

    if (!id) {
      const rawCategory =
        typeof snapshot.category === "string" ? snapshot.category : "lainnya";
      const candidates =
        CATEGORY_DEFAULT_PRESETS[rawCategory] ||
        CATEGORY_DEFAULT_PRESETS.lainnya;
      const index =
        fnv1a32(`${rawCategory}|${String(prompt ?? "")}`) % candidates.length;
      id = candidates[index];
      source = "category";
    }

    const preset = VIBE_PRESETS[id];
    if (!preset) return null;

    return {
      accent: preset.tokens.accent,
      font: preset.fonts.display.family,
      radius: preset.radius,
      preset: {
        id,
        source,
        hint: preset.hint,
        ...preset,
      },
    };
  } catch {
    return null;
  }
}
