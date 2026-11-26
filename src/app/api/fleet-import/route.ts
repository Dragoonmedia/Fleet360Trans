import { NextRequest, NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { verifyToken, revalidateSession } from "@/lib/auth";
import { requireWrite, tenantClause } from "@/lib/guard";
import { classify, plateDigits, CATEGORY_LABEL, type FleetCategory } from "@/lib/fleetSheet";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ROWS = 5000;
const CHUNK = 200;

function auth(req: NextRequest) {
  try {
    return verifyToken(req.cookies.get("fleet360_token")?.value || "");
  } catch {
    return null;
  }
}

type Table = "fuel_records" | "oil_changes" | "tires" | "work_orders";

const TABLE_OF: Record<FleetCategory, Table> = {
  fuel: "fuel_records",
  oil: "oil_changes",
  tires: "tires",
  fees: "work_orders",
  wash: "work_orders",
  maintenance: "work_orders",
};

interface CleanRow {
  equipment: string;
  equipmentDesc: string;
  order: string;
  description: string;
  date: string | null;
  cost: number;
  estimated: boolean;
  enteredBy: string;
}

interface VehicleRow {
  id: number;
  plate_number: string;
  sap_number: string | null;
  driver_name: string | null;
  tenant_id: string | null;
}

const str = (v: unknown, max = 500) => String(v ?? "").trim().slice(0, max);

function cleanRow(r: any): CleanRow | null {
  if (!r || typeof r !== "object") return null;
  const order = str(r.order, 40);
  const equipment = str(r.equipment, 40);
  if (!/^[0-9A-Za-z-]{1,40}$/.test(order) || !/^[0-9A-Za-z-]{1,40}$/.test(equipment)) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || "")) ? String(r.date) : null;
  const cost = Number(r.cost);
  return {
    equipment,
    equipmentDesc: str(r.equipmentDesc, 200),
    order,
    description: str(r.description, 500),
    date,
    cost: isFinite(cost) && Math.abs(cost) < 1e10 ? Math.round(cost * 100) / 100 : 0,
    estimated: Boolean(r.estimated),
    enteredBy: str(r.enteredBy, 60),
  };
}

function rowsOf(res: any): any[] {
  return (res as any)?.rows || [];
}

export async function POST(req: NextRequest) {
  const user = await revalidateSession(auth(req));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requireWrite(user, "fleet_import");
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const input = Array.isArray(body?.rows) ? body.rows : null;
  if (!input || input.length === 0) return NextResponse.json({ error: "الشيت فارغ" }, { status: 400 });
  if (input.length > MAX_ROWS) return NextResponse.json({ error: `الحد الأقصى ${MAX_ROWS} صف` }, { status: 400 });

  // Clean + de-duplicate by SAP order number (last row wins)
  const byOrder = new Map<string, CleanRow>();
  let invalid = 0;
  for (const r of input) {
    const c = cleanRow(r);
    if (c) byOrder.set(c.order, c);
    else invalid++;
  }
  const rows = [...byOrder.values()];

  try {
    const result = await db.transaction(async (tx) => {
      // 1) Vehicles in the caller's scope
      const vehicles = rowsOf(
        await tx.execute(sql`
          SELECT id, plate_number, sap_number, driver_name, tenant_id
          FROM vehicles
          WHERE COALESCE(is_deleted, 0) = 0 AND ${tenantClause(user)}
        `)
      ) as VehicleRow[];

      const bySap = new Map<string, VehicleRow>();
      for (const v of vehicles) if (v.sap_number) bySap.set(String(v.sap_number).trim(), v);

      const digitsOf = (p: string) => (String(p || "").match(/\d+/g) || []).join("");

      // 2) Resolve each SAP equipment number to a vehicle
      const equipmentToVehicle = new Map<string, VehicleRow | null>();
      const linked: { equipment: string; plate: string }[] = [];
      for (const r of rows) {
        if (equipmentToVehicle.has(r.equipment)) continue;
        let v = bySap.get(r.equipment) || null;
        if (!v) {
          // Fallback: match plate digits, only to a vehicle that has no SAP number yet, and only if unique
          const d = plateDigits(r.equipmentDesc);
          const candidates = d ? vehicles.filter((x) => !x.sap_number && digitsOf(x.plate_number) === d) : [];
          if (candidates.length === 1) {
            v = candidates[0];
            await tx.execute(sql`UPDATE vehicles SET sap_number = ${r.equipment} WHERE id = ${v.id}`);
            v.sap_number = r.equipment;
            bySap.set(r.equipment, v);
            linked.push({ equipment: r.equipment, plate: v.plate_number });
          }
        }
        equipmentToVehicle.set(r.equipment, v);
      }

      // 3) Existing records carrying these SAP numbers (any of the 4 lists) -> update instead of insert
      const orders = rows.map((r) => r.order);
      const existing = new Map<string, { table: Table; id: number }>();
      if (orders.length) {
        const orderList = sql.join(orders.map((o) => sql`${o}`), sql`, `);
        for (const table of ["fuel_records", "oil_changes", "tires", "work_orders"] as Table[]) {
          const found = rowsOf(
            await tx.execute(
              sql`SELECT id, sap_number FROM ${sql.raw(table)} WHERE sap_number IN (${orderList}) AND COALESCE(is_deleted, 0) = 0 AND ${tenantClause(user)}`
            )
          );
          for (const f of found) if (!existing.has(f.sap_number)) existing.set(f.sap_number, { table, id: f.id });
        }
      }

      const counts: Record<string, { inserted: number; updated: number; cost: number }> = {};
      for (const k of Object.keys(CATEGORY_LABEL)) counts[k] = { inserted: 0, updated: 0, cost: 0 };
      const unmatched = new Map<string, { equipment: string; equipmentDesc: string; count: number }>();

      const details: {
        order: string; date: string | null; plate: string; equipment: string; equipmentDesc: string;
        description: string; category: string; cost: number; estimated: boolean; status: string;
      }[] = [];
      const inserts: Record<Table, SQL[]> = { fuel_records: [], oil_changes: [], tires: [], work_orders: [] };
      const updates: { table: Table; id: number; r: CleanRow; v: VehicleRow; cat: FleetCategory }[] = [];

      for (const r of rows) {
        const v = equipmentToVehicle.get(r.equipment);
        if (!v) {
          const u = unmatched.get(r.equipment) || { equipment: r.equipment, equipmentDesc: r.equipmentDesc, count: 0 };
          u.count++;
          unmatched.set(r.equipment, u);
          details.push({ order: r.order, date: r.date, plate: "", equipment: r.equipment, equipmentDesc: r.equipmentDesc, description: r.description, category: CATEGORY_LABEL[classify(r.description)], cost: r.cost, estimated: r.estimated, status: "غير مربوط" });
          continue;
        }
        const cat = classify(r.description);
        counts[cat].cost += r.cost;
        const tenant = v.tenant_id || "master";
        const notes = [`SAP ${r.order}`, r.equipmentDesc, r.enteredBy, r.estimated ? "تكلفة تقديرية" : ""]
          .filter(Boolean)
          .join(" | ");

        const ex = existing.get(r.order);
        details.push({ order: r.order, date: r.date, plate: v.plate_number, equipment: r.equipment, equipmentDesc: r.equipmentDesc, description: r.description, category: CATEGORY_LABEL[cat], cost: r.cost, estimated: r.estimated, status: ex ? "محدث" : "جديد" });
        if (ex) {
          updates.push({ table: ex.table, id: ex.id, r, v, cat });
          counts[cat].updated++;
          continue;
        }
        counts[cat].inserted++;
        const table = TABLE_OF[cat];
        if (table === "fuel_records") {
          inserts.fuel_records.push(
            sql`(${tenant}, ${v.id}, ${v.plate_number}, ${v.driver_name || ""}, 0, 0, ${r.cost}, 0, '', ${r.date}::date, ${r.description + " — " + notes}, ${r.order}, 0)`
          );
        } else if (table === "oil_changes") {
          const withFilter = /فلتر|فلاتر/.test(r.description);
          inserts.oil_changes.push(
            sql`(${tenant}, ${v.id}, ${v.plate_number}, ${r.date}::date, ${r.description}, ${r.cost}, ${notes}, ${r.order}, 0, ${withFilter ? "مع فلتر" : "بدون فلتر"}, ${withFilter ? 1 : 0})`
          );
        } else if (table === "tires") {
          inserts.tires.push(
            sql`(${tenant}, ${v.id}, ${v.plate_number}, ${r.date}::date, ${r.cost}, ${r.description + " — " + notes}, ${r.order}, 0)`
          );
        } else {
          inserts.work_orders.push(
            sql`(${tenant}, ${v.id}, ${v.plate_number}, ${"WO-" + r.order}, ${r.order}, ${CATEGORY_LABEL[cat]}, 'مستورد من SAP', 'completed', ${r.cost}, ${r.date}::date, ${r.description}, ${notes}, 0)`
          );
        }
      }

      // 4) Bulk inserts
      const chunks = <T,>(a: T[]) => Array.from({ length: Math.ceil(a.length / CHUNK) }, (_, i) => a.slice(i * CHUNK, (i + 1) * CHUNK));
      for (const part of chunks(inserts.fuel_records))
        await tx.execute(sql`INSERT INTO fuel_records (tenant_id, vehicle_id, plate_number, driver_name, liters, cost_per_liter, total_cost, odometer, station, fuel_date, notes, sap_number, is_deleted) VALUES ${sql.join(part, sql`, `)}`);
      for (const part of chunks(inserts.oil_changes))
        await tx.execute(sql`INSERT INTO oil_changes (tenant_id, vehicle_id, plate_number, change_date, oil_type, cost, notes, sap_number, is_deleted, filter_type, filter_changed) VALUES ${sql.join(part, sql`, `)}`);
      for (const part of chunks(inserts.tires))
        await tx.execute(sql`INSERT INTO tires (tenant_id, vehicle_id, plate_number, install_date, cost, notes, sap_number, is_deleted) VALUES ${sql.join(part, sql`, `)}`);
      for (const part of chunks(inserts.work_orders))
        await tx.execute(sql`INSERT INTO work_orders (tenant_id, vehicle_id, plate_number, order_number, sap_number, maintenance_type, operation_type, status, cost, start_date, description, notes, is_deleted) VALUES ${sql.join(part, sql`, `)}`);

      // 5) Updates of invoices that were already imported (same SAP number)
      for (const u of updates) {
        const { r, v } = u;
        if (u.table === "fuel_records") {
          await tx.execute(sql`UPDATE fuel_records SET vehicle_id = ${v.id}, plate_number = ${v.plate_number}, total_cost = ${r.cost}, fuel_date = ${r.date}::date WHERE id = ${u.id}`);
        } else if (u.table === "oil_changes") {
          await tx.execute(sql`UPDATE oil_changes SET vehicle_id = ${v.id}, plate_number = ${v.plate_number}, cost = ${r.cost}, change_date = ${r.date}::date WHERE id = ${u.id}`);
        } else if (u.table === "tires") {
          await tx.execute(sql`UPDATE tires SET vehicle_id = ${v.id}, plate_number = ${v.plate_number}, cost = ${r.cost}, install_date = ${r.date}::date WHERE id = ${u.id}`);
        } else {
          await tx.execute(sql`UPDATE work_orders SET vehicle_id = ${v.id}, plate_number = ${v.plate_number}, cost = ${r.cost}, start_date = ${r.date}::date, description = ${r.description} WHERE id = ${u.id}`);
        }
      }

      const inserted = Object.values(counts).reduce((a, c) => a + c.inserted, 0);
      const updated = Object.values(counts).reduce((a, c) => a + c.updated, 0);

      await tx.execute(sql`
        INSERT INTO history_logs (tenant_id, plate_number, module_name, action_type, user_name)
        VALUES (${user.tenantId || "master"}, '-', 'داتا الأسطول', ${`استيراد شيت SAP: ${inserted} جديد، ${updated} محدث`}, ${user.username})
      `);

      return {
        total: rows.length,
        duplicatesInFile: input.length - invalid - rows.length,
        invalid,
        inserted,
        updated,
        byCategory: Object.fromEntries(
          Object.entries(counts).map(([k, c]) => [CATEGORY_LABEL[k as FleetCategory], { ...c, cost: Math.round(c.cost * 100) / 100 }])
        ),
        linkedVehicles: linked,
        unmatched: [...unmatched.values()],
        details,
      };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    console.error("fleet-import error:", e);
    return NextResponse.json({ error: "فشل استيراد الشيت، لم يتم حفظ أي بيانات" }, { status: 500 });
  }
}
