import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { verifyToken, revalidateSession } from "@/lib/auth";
import { tenantClause, tenantOf, requireWrite } from "@/lib/guard";

export const dynamic = "force-dynamic";

function auth(req: NextRequest) {
  try {
    const token = req.cookies.get("fleet360_token")?.value;
    return token ? verifyToken(token) : null;
  } catch {
    return null;
  }
}

const isoDate = (v: unknown) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : new Date().toISOString().slice(0, 10);

// GET: tire records in the caller's scope
export async function GET(req: NextRequest) {
  try {
    const user = await revalidateSession(auth(req));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const result = await db.execute(sql`
      SELECT
        id, tenant_id, vehicle_id,
        COALESCE(plate_number, '') AS plate_number,
        COALESCE(plate_number, '') AS "plateNumber",
        COALESCE(tire_brand, '') AS brand,
        COALESCE(tire_size, '') AS size,
        install_date::text AS "installDate",
        install_date::text AS install_date,
        COALESCE(km_at_install, 0) AS "kmAtInstall",
        COALESCE(next_change_km, 0) AS "nextChangeKm",
        COALESCE(cost, 0)::numeric AS cost,
        COALESCE(notes, '') AS notes,
        COALESCE(sap_number, '') AS sap_number,
        COALESCE(sap_number, '') AS "sapNumber"
      FROM tires
      WHERE COALESCE(is_deleted, 0) = 0 AND ${tenantClause(user)}
      ORDER BY install_date DESC NULLS LAST, id DESC
    `);
    return NextResponse.json((result as any).rows || []);
  } catch (error) {
    console.error("GET Tires Error:", error);
    return NextResponse.json({ error: "فشل جلب بيانات الكاوتش" }, { status: 500 });
  }
}

// POST: add a tire record
export async function POST(req: NextRequest) {
  try {
    const user = await revalidateSession(auth(req));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = requireWrite(user, "tires");
    if (denied) return denied;

    const b = await req.json().catch(() => ({}));
    const plateNumber = String(b.plateNumber || b.plate_number || "").trim();
    if (!plateNumber) return NextResponse.json({ error: "رقم اللوحة مطلوب" }, { status: 400 });

    const veh = await db.execute(sql`
      SELECT id, tenant_id FROM vehicles
      WHERE plate_number = ${plateNumber} AND COALESCE(is_deleted, 0) = 0 AND ${tenantClause(user)}
      LIMIT 1
    `);
    const v = ((veh as any).rows || [])[0];

    const result = await db.execute(sql`
      INSERT INTO tires (
        tenant_id, vehicle_id, plate_number, tire_brand, tire_size, install_date,
        km_at_install, next_change_km, cost, notes, sap_number, is_deleted
      ) VALUES (
        ${v?.tenant_id || tenantOf(user)}, ${v?.id ?? null}, ${plateNumber},
        ${String(b.brand || "").trim()}, ${String(b.size || "").trim()}, ${isoDate(b.installDate || b.install_date)}::date,
        ${Number(b.kmAtInstall || b.odometerAtInstall) || 0}, ${Number(b.nextChangeKm || b.next_change_km) || 0},
        ${Number(b.cost) || 0}, ${String(b.notes || "")}, ${String(b.sapNumber || b.sap_number || "").trim().slice(0, 40) || null}, 0
      )
      RETURNING id
    `);

    return NextResponse.json({ success: true, id: ((result as any).rows || [])[0]?.id }, { status: 201 });
  } catch (error) {
    console.error("POST Tire Error:", error);
    return NextResponse.json({ error: "فشل الحفظ" }, { status: 500 });
  }
}
