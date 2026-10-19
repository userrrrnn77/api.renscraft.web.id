// services/brief/briefTypes.ts
//
// Tipe bersama untuk fitur brief. slotCatalog.js / slotValidate.js / models/Brief.js
// tetap JS, jadi tipenya didefinisikan di sini dan dipasang lewat briefCatalog.ts.
import type { Types } from "mongoose";

export type SlotKind =
  | "text"
  | "longtext"
  | "list"
  | "choice"
  | "phone"
  | "email"
  | "handle"
  | "url";

// kind yang boleh dipakai slot tambahan (x_*) dari classifier
export type ExtraKind = "text" | "longtext" | "list";

export type SlotGroup = "fact" | "style";

export interface SlotDef {
  key: string;
  label: string;
  question: string;
  kind: SlotKind;
  group: SlotGroup;
  placeholder?: string;
  options?: readonly string[];
}

export interface CategoryDef {
  id: string;
  label: string;
  hint: string;
  slots: readonly string[];
  sampleData?: boolean;
}

export interface ExtraSlot {
  key: string;
  label: string;
  question: string;
  kind: ExtraKind;
}

export type AnswerSource = "prompt" | "user" | "skipped";

export interface AnswerEntry {
  value: string | null;
  source: AnswerSource;
}

// Tidak ada key = belum ditanya / belum dijawab.
export type Answers = Record<string, AnswerEntry>;

export type BriefStatus = "open" | "used";

// Bentuk dokumen Brief (lean). Dipakai sebagai pengganti inferensi dari Brief.js.
export interface BriefRecord {
  _id: Types.ObjectId;
  owner: Types.ObjectId;
  prompt: string;
  category: string;
  confidence?: number | null;
  answers: Answers;
  extra: ExtraSlot[];
  questionKeys: string[];
  status: BriefStatus;
  createdAt: Date;
  updatedAt: Date;
}

// ─── bentuk respons API ──────────────────────────────────────────────────────

export interface QuestionView {
  key: string;
  label: string;
  question: string;
  kind: SlotKind;
  group: SlotGroup;
  options?: readonly string[];
  // null = belum dijawab
  answer: AnswerEntry | null;
}

// Slot yang sudah terisi di luar daftar pertanyaan (dari prompt / jawaban lama)
export interface KnownView {
  key: string;
  label: string;
  value: string;
  source: AnswerSource;
}

export interface BriefView {
  id: string;
  status: BriefStatus;
  category: { id: string; label: string };
  confidence: number | null;
  // urutan TETAP selama kategori tidak berganti: index di client aman
  questions: QuestionView[];
  known: KnownView[];
  progress: {
    answered: number;
    total: number;
    done: boolean;
    nextKey: string | null;
  };
}
