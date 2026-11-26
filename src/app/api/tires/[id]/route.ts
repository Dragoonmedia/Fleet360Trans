import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { verifyToken, revalidateSession } from "@/lib/auth";
import { tenantClause, requireWrite } from "@/lib/guard";

export const dynamic = "force-dynamic";

function auth(req: NextRequest) {
  try {
    const token = req.cookies.get("fleet360_token")?.value;
    return token ? verifyToken(token) : null;
  } catch {
    return null;
  }
}

type Ctx = { params: Promise<{ id: string }> | { id: string } };

async function idOf(ctx: Ctx) {
  const p = await Promise.resolve(ctx.params);
  const id = Number(p?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const user = await revalidateSession(auth(req));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const id = await idOf(ctx);
    if (!id) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });

    const rows = ((await db.execute(sql`
      SELECT * FROM tires WHERE id = ${id} AND COALESCE(is_deleted, 0) = 0 AND ${tenantClause(user)}
    `)) as any).rows || [];
    if (!rows[0]) return NextResponse.json({ error: "السجل غير موجود" }, { status: 404 });
    return NextResponse.json(rows[0]);
  } catch {
    return NextResponse.json({ error: "حدث خطأ أثناء جلب البيانات" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const user = await revalidateSession(auth(req));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = requireWrite(user, "tires");
    if (denied) return denied;
    const id = await idOf(ctx);
    if (!id) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });

    const b = await req.json().catch(() => ({}));
    const installDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.installDate || "")) ? String(b.installDate) : null;

    const rows = ((await db.execute(sql`
      UPDATE tires SET
        tire_brand = ${String(b.brand || "")},
        tire_size = ${String(b.size || "")},
        cost = ${Number(b.cost) || 0},
        next_change_km = ${Number(b.nextChangeKm || b.next_change_km) || 0},
        install_date = COALESCE(${installDate}::date, install_date),
        notes = ${String(b.notes || "")}
      WHERE id = ${id} AND COALESCE(is_deleted, 0) = 0 AND ${tenantClause(user)}
      RETURNING id
    `)) as any).rows || [];
    if (!rows[0]) return NextResponse.json({ error: "السجل غير موجود" }, { status: 404 });
    return NextResponse.json({ success: true, id });
  } catch {
    return NextResponse.json({ error: "فشل التعديل" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const user = await revalidateSession(auth(req));
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = requireWrite(user, "tires");
    if (denied) return denied;
    const id = await idOf(ctx);
    if (!id) return NextResponse.json({ error: "معرّف غير صالح" }, { status: 400 });

    const rows = ((await db.execute(sql`
      UPDATE tires SET is_deleted = 1 WHERE id = ${id} AND ${tenantClause(user)} RETURNING id
    `)) as any).rows || [];
    if (!rows[0]) return NextResponse.json({ error: "العنصر غير موجود" }, { status: 404 });
    return NextResponse.json({ success: true, deletedId: id });
  } catch {
    return NextResponse.json({ error: "فشل الحذف" }, { status: 500 });
  }
}
