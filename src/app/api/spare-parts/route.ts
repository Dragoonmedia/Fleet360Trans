import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { verifyToken, revalidateSession } from "@/lib/auth";
import { tenantOf } from "@/lib/guard";

export const dynamic = "force-dynamic";

function auth(req: NextRequest) {
  try { return verifyToken(req.cookies.get("fleet360_token")?.value || ""); } catch { return null; }
}

export async function GET(req: NextRequest) {
  try {
    const user = await revalidateSession(auth(req));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const raw = await db.execute(sql`SELECT * FROM spare_parts WHERE tenant_id = ${tenantOf(user)} ORDER BY id DESC`);
    const rows = (raw as any).rows || raw || [];
    const formatted = rows.map((r: any) => ({
      ...r, partName: r.part_name, partNumber: r.part_number, minimumQuantity: r.minimum_quantity, unitPrice: r.unit_price
    }));
    return NextResponse.json(formatted);
  } catch { return NextResponse.json([]); }
}

export async function POST(req: NextRequest) {
  try {
    const user = await revalidateSession(auth(req));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const b = await req.json().catch(() => ({}));

    const result = await db.execute(sql`
      INSERT INTO spare_parts (
        tenant_id, part_name, part_number, category, quantity, minimum_quantity, unit_price, supplier, location, status, notes
      ) VALUES (
        ${tenantOf(user)}, ${b.partName || ""}, ${b.partNumber || ""}, ${b.category || ""}, ${Number(b.quantity) || 0}, 
        ${Number(b.minimumQuantity) || 0}, ${Number(b.unitPrice) || 0}, ${b.supplier || ""}, ${b.location || ""}, ${b.status || "available"}, ${b.notes || ""}
      ) RETURNING *
    `);

    return NextResponse.json({ success: true, data: (result as any).rows?.[0] }, { status: 201 });
  } catch (e: any) { return NextResponse.json({ error: "حدث خطأ" }, { status: 500 }); }
}
