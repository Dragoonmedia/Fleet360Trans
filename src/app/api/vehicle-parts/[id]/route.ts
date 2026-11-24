import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { vehicleParts } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { verifyToken, revalidateSession } from "@/lib/auth";
import { ROLE_POWER, powerOf, isGlobalUser, tenantOf } from "@/lib/guard";

function auth(req: NextRequest) {
  const token = req.cookies.get("fleet360_token")?.value;
  if (!token) return null;
  return verifyToken(token);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await revalidateSession(auth(req));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const partId = parseInt(id);
  if (!partId) return NextResponse.json({ error: "معرف غير صالح" }, { status: 400 });
  const body = await req.json().catch(() => ({}));

  // 🔒 كان بيعمل set({ ...body }) فأي حقل (زي tenantId أو id) كان ممكن يتغير. دلوقتي قائمة حقول مسموحة فقط.
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  const textFields = ["plateNumber", "partName", "partCategory", "brand", "condition", "notes"] as const;
  for (const f of textFields) if (body[f] !== undefined) patch[f] = String(body[f]);
  if (body.installDate !== undefined) patch.installDate = body.installDate ? String(body.installDate).slice(0, 10) : null;
  if (body.kmAtInstall !== undefined) patch.kmAtInstall = Number(body.kmAtInstall) || 0;
  if (body.cost !== undefined) patch.cost = String(Number(body.cost) || 0);

  const [row] = await db
    .update(vehicleParts)
    .set(patch as any)
    .where(and(eq(vehicleParts.id, partId), isGlobalUser(user) ? undefined : sql`COALESCE(${vehicleParts.tenantId}, 'master') = ${tenantOf(user)}`))
    .returning();
  if (!row) return NextResponse.json({ error: "غير موجود" }, { status: 404 });
  return NextResponse.json(row);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await revalidateSession(auth(req));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // كان الشرط user.role !== "admin" فبيمنع owner و super_admin. دلوقتي: admin فما فوق.
  if (powerOf(user.role) < ROLE_POWER.admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  await db
    .delete(vehicleParts)
    .where(and(eq(vehicleParts.id, parseInt(id)), isGlobalUser(user) ? undefined : sql`COALESCE(${vehicleParts.tenantId}, 'master') = ${tenantOf(user)}`));
  return NextResponse.json({ success: true });
}
