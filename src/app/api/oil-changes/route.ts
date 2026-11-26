import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { verifyToken, revalidateSession } from "@/lib/auth";
import { tenantClause, tenantOf, requireWrite } from "@/lib/guard";

export const dynamic = "force-dynamic";

function auth(req: NextRequest) {
  try {
    return verifyToken(req.cookies.get("fleet360_token")?.value || "");
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await revalidateSession(auth(req));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // 🔒 كان أي فرع بيشوف بيانات فرع master كمان. دلوقتي كل فرع بيشوف بياناته بس.
    const tenantFilter = tenantClause(user);

    const records = await db.execute(sql`
      SELECT 
        id,
        tenant_id,
        vehicle_id,
        COALESCE(plate_number, '') as plate_number,
        COALESCE(plate_number, '') as "plateNumber",
        COALESCE(oil_type, 'تغيير زيت وفلاتر') as oil_type,
        COALESCE(oil_type, 'تغيير زيت وفلاتر') as "oilType",
        COALESCE(brand, oil_brand, '-') as brand,
        COALESCE(filter_type, CASE WHEN filter_changed = 1 THEN 'مع فلتر' ELSE 'بدون فلتر' END) as "filterType",
        COALESCE(current_km, odometer_at_change, 0) as "currentKm",
        COALESCE(current_km, odometer_at_change, 0) as current_km,
        COALESCE(next_km, next_change_km, 0) as "nextKm",
        COALESCE(next_km, next_change_km, 0) as next_km,
        COALESCE(cost, 0)::numeric as cost,
        COALESCE(change_date::text, created_at::date::text, '') as "changeDate",
        COALESCE(change_date::text, created_at::date::text, '') as change_date,
        COALESCE(sap_number, '') as sap_number,
        COALESCE(sap_number, '') as "sapNumber",
        COALESCE(notes, '') as notes,
        COALESCE(is_deleted, 0) as is_deleted
      FROM oil_changes
      WHERE (is_deleted = 0 OR is_deleted IS NULL) AND ${tenantFilter}
      ORDER BY id DESC
    `);

    const rows = (records as any).rows || records || [];
    return NextResponse.json(rows);
  } catch (error: any) {
    console.error("GET oil-changes error:", error);
    return NextResponse.json({ error: "API Error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await revalidateSession(auth(req));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = requireWrite(user, "oil");
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    const plate = String(body.plateNumber || body.plate_number || "").trim();
    if (!plate) return NextResponse.json({ error: "رقم اللوحة مطلوب" }, { status: 400 });

    const currentKm = parseFloat(String(body.currentKm ?? body.current_km ?? 0)) || 0;
    const nextKm = parseFloat(String(body.nextKm ?? body.next_km ?? 0)) || 0;
    const cost = parseFloat(String(body.cost ?? body.total_cost ?? 0)) || 0;
    const oilType = String(body.oilType || body.oil_type || "تغيير زيت وفلاتر").trim();
    const brand = String(body.brand || "").trim();
    const changeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.changeDate || body.change_date || ""))
      ? String(body.changeDate || body.change_date)
      : new Date().toISOString().slice(0, 10);
    const filterType = String(body.filterType || "مع فلتر");
    const sap = String(body.sapNumber || body.sap_number || "").trim().slice(0, 40);

    // the vehicle must be in the caller's scope
    const veh = await db.execute(sql`
      SELECT id, tenant_id FROM vehicles
      WHERE plate_number = ${plate} AND COALESCE(is_deleted, 0) = 0 AND ${tenantClause(user)}
      LIMIT 1
    `);
    const v = ((veh as any).rows || [])[0];

    const result = await db.execute(sql`
      INSERT INTO oil_changes (
        tenant_id, vehicle_id, plate_number, change_date, oil_type, brand, oil_brand, cost,
        current_km, odometer_at_change, next_km, next_change_km, filter_type, filter_changed,
        notes, sap_number, is_deleted
      ) VALUES (
        ${v?.tenant_id || tenantOf(user)}, ${v?.id ?? null}, ${plate}, ${changeDate}::date, ${oilType}, ${brand}, ${brand}, ${cost},
        ${currentKm}, ${currentKm}, ${nextKm}, ${nextKm}, ${filterType}, ${filterType.includes("مع") ? 1 : 0},
        ${String(body.notes || "")}, ${sap || null}, 0
      )
      RETURNING id
    `);

    if (v?.id && currentKm > 0) {
      await db.execute(sql`UPDATE vehicles SET current_km = GREATEST(COALESCE(current_km, 0), ${currentKm}) WHERE id = ${v.id}`);
    }

    return NextResponse.json({ success: true, id: ((result as any).rows || [])[0]?.id }, { status: 201 });
  } catch (error) {
    console.error("POST oil-changes error:", error);
    return NextResponse.json({ error: "فشل الحفظ" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await revalidateSession(auth(req));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = requireWrite(user, "oil");
    if (denied) return denied;

    const body = await req.json();
    const id = body.id;
    if (!id) return NextResponse.json({ error: "Missing ID" }, { status: 400 });

    const currentKm = parseFloat(String(body.currentKm ?? body.current_km ?? 0)) || 0;
    const nextKm = parseFloat(String(body.nextKm ?? body.next_km ?? 0)) || 0;
    const cost = parseFloat(String(body.cost ?? body.total_cost ?? 0)) || 0;
    const oilType = String(body.oilType || body.oil_type || "تغيير زيت وفلاتر").trim();
    const brand = String(body.brand || "").trim();
    const changeDate = body.changeDate || body.change_date || new Date().toISOString().slice(0, 10);
    const filterType = String(body.filterType || "مع فلتر");
    const filterChanged = filterType.includes("مع") ? 1 : 0;

    await db.execute(sql`
      UPDATE oil_changes
      SET
        oil_type = ${oilType},
        brand = ${brand},
        oil_brand = ${brand},
        cost = ${cost},
        change_date = ${changeDate}::date,
        current_km = ${currentKm},
        odometer_at_change = ${currentKm},
        next_km = ${nextKm},
        next_change_km = ${nextKm},
        filter_changed = ${filterChanged},
        filter_type = ${filterType}
      WHERE id = ${Number(id)} AND ${tenantClause(user)}
    `);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("PUT oil-changes error:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}
