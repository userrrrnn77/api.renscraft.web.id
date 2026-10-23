// services/brief/slotCatalog.js
//
// Katalog "slot" = data yang TIDAK boleh dikarang AI. Dua grup:
//   fact  -> nama, alamat, kontak, harga, jam, menu, data project. Kosong = placeholder.
//   style -> preferensi tampilan. Kosong = AI bebas memilih.
// Copy kreatif (tagline, deskripsi, judul section) bukan slot: itu urusan AI.
//
// Tambah kategori baru = tambah satu entri di CATEGORIES (daftar key slot-nya).
// Kategori yang tidak dikenal jatuh ke "lainnya", dan classifier boleh mengusulkan
// maksimal 3 slot tambahan (key diawali x_).

export const MAX_QUESTIONS = 5;

export const VIBE_OPTIONS = [
  "Modern minimalis",
  "Vintage / hangat",
  "Playful & berwarna",
  "Elegan / mewah",
  "Gelap & techy",
];

// kind: text | longtext | list | choice | phone | email | handle | url
export const SLOTS = {
  brand_name: {
    label: "Nama brand / judul",
    question: "Nama brand atau judul webnya apa?",
    kind: "text",
    group: "fact",
    placeholder: "Nama Brand",
  },
  address: {
    label: "Alamat",
    question: "Alamat lengkapnya di mana?",
    kind: "longtext",
    group: "fact",
    placeholder: "Alamat belum diisi",
  },
  whatsapp: {
    label: "WhatsApp",
    question: "Nomor WhatsApp untuk dihubungi?",
    kind: "phone",
    group: "fact",
    placeholder: "Nomor WhatsApp belum diisi",
  },
  instagram: {
    label: "Instagram",
    question: "Username Instagram?",
    kind: "handle",
    group: "fact",
    placeholder: "Instagram belum diisi",
  },
  email: {
    label: "Email",
    question: "Alamat email untuk dihubungi?",
    kind: "email",
    group: "fact",
    placeholder: "Email belum diisi",
  },
  jam_buka: {
    label: "Jam buka",
    question: "Jam bukanya?",
    kind: "text",
    group: "fact",
    placeholder: "Jam buka belum diisi",
  },
  vibe: {
    label: "Gaya tampilan",
    question: "Gaya tampilannya mau yang mana?",
    kind: "choice",
    group: "style",
    options: VIBE_OPTIONS,
  },

  // kuliner
  menu: {
    label: "Menu & harga",
    question: "Menunya apa saja + harganya? (satu per baris: Nama - harga)",
    kind: "list",
    group: "fact",
    placeholder: "Menu akan tampil di sini",
  },
  best_seller: {
    label: "Best seller",
    question: "Menu andalan / best seller-nya apa?",
    kind: "text",
    group: "fact",
    placeholder: "Menu andalan belum diisi",
  },

  // portfolio
  profesi: {
    label: "Profesi",
    question: "Profesinya apa? Contoh: Fullstack Web Dev, UI/UX, Data Analyst",
    kind: "text",
    group: "fact",
    placeholder: "Profesi belum diisi",
  },
  bio: {
    label: "Bio singkat",
    question: "Bio singkat 1-2 kalimat tentang kamu?",
    kind: "longtext",
    group: "fact",
    placeholder: "Bio belum diisi",
  },
  tech_stack: {
    label: "Tech stack",
    question: "Tech stack / skill utamanya? (satu per baris)",
    kind: "list",
    group: "fact",
    placeholder: "Skill belum diisi",
  },
  projects: {
    label: "Project",
    question:
      "Project yang mau ditampilkan? (satu per baris: Judul | deskripsi | link)",
    kind: "list",
    group: "fact",
    placeholder: "Project akan tampil di sini",
  },
  github: {
    label: "GitHub",
    question: "Link GitHub?",
    kind: "url",
    group: "fact",
    placeholder: "GitHub belum diisi",
  },
  linkedin: {
    label: "LinkedIn",
    question: "Link LinkedIn?",
    kind: "url",
    group: "fact",
    placeholder: "LinkedIn belum diisi",
  },
  cv_url: {
    label: "Link CV",
    question: "Link download CV? (kosongkan kalau tidak ada tombol CV)",
    kind: "url",
    group: "fact",
    placeholder: "",
  },

  // toko / produk
  produk: {
    label: "Produk & harga",
    question: "Produk yang dijual + harganya? (satu per baris: Nama - harga)",
    kind: "list",
    group: "fact",
    placeholder: "Produk akan tampil di sini",
  },
  cara_order: {
    label: "Cara order",
    question: "Cara ordernya gimana?",
    kind: "text",
    group: "fact",
    placeholder: "Cara order belum diisi",
  },
  area_kirim: {
    label: "Area pengiriman",
    question: "Area pengiriman / jangkauannya?",
    kind: "text",
    group: "fact",
    placeholder: "Area pengiriman belum diisi",
  },

  // jasa
  layanan: {
    label: "Layanan & harga",
    question:
      "Layanannya apa saja? (satu per baris: Layanan - harga / mulai dari)",
    kind: "list",
    group: "fact",
    placeholder: "Layanan akan tampil di sini",
  },
  area_layanan: {
    label: "Area layanan",
    question: "Area layanannya di mana?",
    kind: "text",
    group: "fact",
    placeholder: "Area layanan belum diisi",
  },

  // event / undangan
  tanggal: {
    label: "Tanggal",
    question: "Tanggal acaranya?",
    kind: "text",
    group: "fact",
    placeholder: "Tanggal belum diisi",
  },
  waktu: {
    label: "Waktu",
    question: "Jam acaranya?",
    kind: "text",
    group: "fact",
    placeholder: "Waktu belum diisi",
  },
  rsvp: {
    label: "Kontak RSVP",
    question: "Nomor WhatsApp untuk RSVP?",
    kind: "phone",
    group: "fact",
    placeholder: "Kontak RSVP belum diisi",
  },
  rundown: {
    label: "Rundown",
    question: "Rundown acaranya? (satu per baris: jam - kegiatan)",
    kind: "list",
    group: "fact",
    placeholder: "Rundown akan tampil di sini",
  },

  // artikel
  penulis: {
    label: "Penulis",
    question: "Nama penulisnya?",
    kind: "text",
    group: "fact",
    placeholder: "Penulis belum diisi",
  },
  topik: {
    label: "Topik",
    question: "Topik / sudut pandang artikelnya?",
    kind: "text",
    group: "style",
  },
  isi_artikel: {
    label: "Isi artikel",
    question: "Tempel isi artikelnya (atau poin-poin utamanya)",
    kind: "longtext",
    group: "fact",
    placeholder: "Isi artikel akan tampil di sini",
  },

  // brosur
  profil_singkat: {
    label: "Profil singkat",
    question: "Profil singkat usahanya, 1-2 kalimat?",
    kind: "longtext",
    group: "fact",
    placeholder: "Profil singkat belum diisi",
  },
  penawaran: {
    label: "Produk / paket",
    question: "Produk atau paket yang ditawarkan + harga? (satu per baris)",
    kind: "list",
    group: "fact",
    placeholder: "Penawaran akan tampil di sini",
  },
  promo: {
    label: "Promo",
    question: "Ada promo yang mau ditonjolkan? (kosongkan kalau tidak ada)",
    kind: "text",
    group: "fact",
    placeholder: "",
  },
};

// Urutan key = urutan pertanyaan. Yang paling penting di depan, karena hanya
// MAX_QUESTIONS pertama yang ditanya; sisanya jadi placeholder.
export const CATEGORIES = [
  {
    id: "kuliner",
    label: "Kuliner",
    hint: "warkop, cafe, restoran, warung, katering, toko kue, bakery",
    slots: [
      "brand_name",
      "menu",
      "address",
      "jam_buka",
      "whatsapp",
      "best_seller",
      "instagram",
      "vibe",
    ],
  },
  {
    id: "portfolio",
    label: "Portfolio",
    hint: "portfolio / CV online / personal website developer, desainer, fotografer, freelancer",
    slots: [
      "brand_name",
      "profesi",
      "bio",
      "projects",
      "tech_stack",
      "github",
      "linkedin",
      "email",
      "cv_url",
      "vibe",
    ],
  },
  {
    id: "jasa",
    label: "Jasa / Layanan",
    hint: "bengkel, salon, laundry, les privat, fotografi, konsultan, kontraktor, klinik",
    slots: [
      "brand_name",
      "layanan",
      "whatsapp",
      "address",
      "jam_buka",
      "area_layanan",
      "vibe",
    ],
  },
  {
    id: "event",
    label: "Event / Undangan",
    hint: "undangan pernikahan, ulang tahun, seminar, reuni, acara komunitas",
    slots: [
      "brand_name",
      "tanggal",
      "waktu",
      "address",
      "rsvp",
      "rundown",
      "vibe",
    ],
  },
  {
    id: "artikel",
    label: "Artikel / Blog",
    hint: "artikel, blog, berita, tulisan, halaman edukasi",
    slots: ["brand_name", "isi_artikel", "penulis", "topik", "vibe"],
  },
  {
    id: "brosur",
    label: "Brosur online",
    hint: "brosur, company profile satu halaman, flyer digital, katalog singkat",
    slots: [
      "brand_name",
      "profil_singkat",
      "penawaran",
      "whatsapp",
      "address",
      "jam_buka",
      "promo",
      "vibe",
    ],
  },
  {
    // game, kalkulator, todo, timer: tidak butuh data dari user
    id: "app_tool",
    label: "Aplikasi / Game / Tool",
    hint: "game, kalkulator, todo app, timer, converter, quiz",
    slots: [],
  },
  {
    // tanpa database tidak ada data asli: tampilan demo berlabel DATA CONTOH
    id: "dashboard",
    label: "Dashboard (demo)",
    hint: "dashboard, panel admin, laporan statistik",
    slots: [],
    sampleData: true,
  },
  {
    id: "toko_produk",
    label: "Toko / Produk",
    hint: "toko online, katalog produk, warung sembako, toko kelontong, toko bahan pokok, bouquet, fashion, kerajinan, jualan barang",
    slots: [
      "brand_name",
      "produk",
      "whatsapp",
      "cara_order",
      "instagram",
      "area_kirim",
      "vibe",
    ],
  },
  {
    id: "lainnya",
    label: "Lainnya",
    hint: "semua yang tidak cocok dengan kategori lain",
    slots: ["brand_name", "whatsapp", "address", "vibe"],
  },
];

export const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
for (const [i, c] of CATEGORIES.entries()) {
  if (!Array.isArray(c.slots)) {
    throw new Error(`[slotCatalog] kategori "${c.id}" tidak punya slots[]`);
  }
  if (CATEGORIES.findIndex((x) => x.id === c.id) !== i) {
    throw new Error(`[slotCatalog] id kategori dobel: "${c.id}"`);
  }
}

export const getCategory = (id) =>
  CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];

export const EXTRA_KEY_RE = /^x_[a-z0-9_]{2,30}$/;
export const EXTRA_KINDS = ["text", "longtext", "list"];

// Definisi slot lengkap (dengan key) untuk satu kategori, plus slot tambahan
// dari classifier ("lainnya" saja). `extra` = [{ key, label, question?, kind }]
export function categorySlots(categoryId, extra = []) {
  const cat = getCategory(categoryId);
  const defs = cat.slots.map((key) => ({ key, ...SLOTS[key] }));
  if (cat.id === "lainnya") {
    for (const e of extra) {
      defs.push({
        key: e.key,
        label: e.label,
        question: e.question || `${e.label}?`,
        kind: e.kind,
        group: "fact",
        placeholder: `${e.label} belum diisi`,
      });
    }
  }
  return defs;
}
