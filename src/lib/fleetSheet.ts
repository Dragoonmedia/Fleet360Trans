// Parsing and classification of the monthly SAP PM export
// (columns: Plant, Equipment, Description, Order Type, Order, Description, Main WorkCtr,
//  Bas. start date, Entered by, Estimated costs, Total act.costs).
// Shared by the browser (to detect and normalise the file) and the server (to classify and store).

export type FleetCategory = "fuel" | "oil" | "tires" | "fees" | "wash" | "maintenance";

export const CATEGORY_LABEL: Record<FleetCategory, string> = {
  fuel: "وقود",
  oil: "زيوت",
  tires: "كاوتش",
  fees: "رسوم وتراخيص",
  wash: "غسيل",
  maintenance: "صيانة",
};

export interface SapSheetRow {
  equipment: string; // SAP equipment number = vehicles.sap_number
  equipmentDesc: string; // model + plate text from SAP
  order: string; // SAP order number = invoice number
  description: string; // what the invoice is for
  date: string | null; // YYYY-MM-DD
  cost: number;
  estimated: boolean; // true when SAP has no actual cost yet and the estimate was used
  enteredBy: string;
}

const norm = (s: string) =>
  s
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[ً-ْ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Decide which list an invoice belongs to, from its SAP description. Order matters. */
export function classify(description: string): FleetCategory {
  const d = norm(description || "");
  if (/(تغيير|غيار)\s*(ال)?زيت|فلتر\s*زيت|زيت\s*(و\s*)?فلتر|زيت\s*موتور|زيت\s*محرك/.test(d)) return "oil";
  if (/كاوتش|اطار|ترصيص|زوايا/.test(d)) return "tires";
  if (/(وقود|تفويل|سولار|بنزين)/.test(d) && !/ترخيص|تراخيص/.test(d)) return "fuel";
  if (
    /ترخيص|تراخيص|رخصه|تصريح|تسيير|تسسير|كارته|كارتت|باركينج|جراج|تامين|مخالف|رسوم/.test(d) &&
    !/اصلاح|صيانه|عمره/.test(d)
  )
    return "fees";
  // washing only when the invoice is just a wash (otherwise it is maintenance work that included a wash)
  if (/غسيل/.test(d)) {
    const rest = d
      .replace(/غسيل|تشحيم|خارجي|داخلي|سياره|سيارات|مرتين|مرات|عدد|للسياره/g, " ")
      .replace(/[0-9\-_.،,+()\/]/g, " ")
      .replace(/(^|\s)و(\s|$)/g, " ")
      .trim();
    if (!rest) return "wash";
  }
  return "maintenance";
}

/** Digits of the plate number at the end of an SAP equipment description, e.g. "Suzuki van ل د ا 9684" -> "9684". */
export function plateDigits(text: string): string {
  const m = String(text || "").match(/(\d{3,5})\s*$/) || String(text || "").match(/(\d{3,5})(?!.*\d)/);
  return m ? m[1] : "";
}

function cleanKey(k: string) {
  return k.toLowerCase().replace(/[\s._\-]/g, "");
}

function pick(row: Record<string, any>, ...keys: string[]): any {
  const map: Record<string, any> = {};
  for (const k of Object.keys(row)) map[cleanKey(k)] = row[k];
  for (const k of keys) {
    const v = map[cleanKey(k)];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

/** True when the parsed sheet looks like the SAP PM export. */
export function isSapSheet(rows: Record<string, any>[]): boolean {
  if (!rows?.length) return false;
  const keys = Object.keys(rows[0]).map(cleanKey);
  return keys.includes("equipment") && keys.includes("order");
}

function toIsoDate(v: any): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    // Spreadsheet dates have no time part, but the parsed Date can land a few seconds/hours
    // before midnight depending on time zone. Shift to midday before reading the calendar date.
    return new Date(v.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);
  }
  if (typeof v === "number") {
    const dt = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; // SAP uses DD.MM.YYYY
  return null;
}

function num(v: any): number {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? "").replace(/,/g, "").replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : 0;
}

function intText(v: any): string {
  const s = String(v ?? "").trim();
  return /^\d+(\.0+)?$/.test(s) ? s.replace(/\.0+$/, "") : s;
}

/** Normalise rows from sheet_to_json (duplicate "Description" header becomes "Description_1"). */
export function normalizeSapRows(rows: Record<string, any>[]): SapSheetRow[] {
  const out: SapSheetRow[] = [];
  for (const r of rows) {
    const order = intText(pick(r, "Order"));
    const equipment = intText(pick(r, "Equipment"));
    if (!order || !equipment) continue;
    const act = num(pick(r, "Total act.costs", "Total act costs", "Actual costs"));
    const est = num(pick(r, "Estimated costs"));
    out.push({
      equipment,
      equipmentDesc: String(pick(r, "Description") || "").trim(),
      order,
      description: String(pick(r, "Description_1", "Description 1", "Order Description") || "").trim(),
      date: toIsoDate(pick(r, "Bas. start date", "Basic start date", "Start date")),
      cost: act || est,
      estimated: !act && !!est,
      enteredBy: String(pick(r, "Entered by") || "").trim(),
    });
  }
  return out;
}
