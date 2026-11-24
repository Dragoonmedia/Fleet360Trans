import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { vehiclePartsHistory } from "@/db/schema";
import { eq, and, gte, lte, ilike, sql } from "drizzle-orm";
import { verifyToken, revalidateSession } from "@/lib/auth";
import { isGlobalUser, tenantOf } from "@/lib/guard";

function auth(req: NextRequest) {
  const token = req.cookies.get("fleet360_token")?.value;
  if (!token) return null;
  return verifyToken(token);
}

export async function GET(req: NextRequest) {
  const user = await revalidateSession(auth(req));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const vehicleId = searchParams.get("vehicleId") || "";
  const partId = searchParams.get("partId") || "";
  const partName = searchParams.get("partName") || "";
  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";

  let conditions: any[] = [];
  if (!isGlobalUser(user)) conditions.push(sql`COALESCE(${vehiclePartsHistory.tenantId}, 'master') = ${tenantOf(user)}`);
  if (vehicleId) conditions.push(eq(vehiclePartsHistory.vehicleId, parseInt(vehicleId)));
  if (partId) conditions.push(eq(vehiclePartsHistory.vehiclePartId, parseInt(partId)));
  if (partName) conditions.push(ilike(vehiclePartsHistory.partName, `%${partName}%`));
  if (from) conditions.push(gte(vehiclePartsHistory.createdAt, new Date(from)));
  if (to) conditions.push(lte(vehiclePartsHistory.createdAt, new Date(to + "T23:59:59")));

  const rows = conditions.length > 0
    ? await db.select().from(vehiclePartsHistory).where(and(...conditions)).orderBy(vehiclePartsHistory.createdAt)
    : await db.select().from(vehiclePartsHistory).orderBy(vehiclePartsHistory.createdAt);

  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const user = await revalidateSession(auth(req));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  // 🔒 قائمة حقول مسموحة + الـ tenant بيتحدد من التوكن مش من الـ body
  const [row] = await db.insert(vehiclePartsHistory).values({
    tenantId: tenantOf(user),
    vehicleId: b.vehicleId != null ? Number(b.vehicleId) : null,
    vehiclePartId: b.vehiclePartId != null ? Number(b.vehiclePartId) : null,
    plateNumber: b.plateNumber ? String(b.plateNumber) : null,
    partName: b.partName ? String(b.partName) : null,
    partCategory: b.partCategory ? String(b.partCategory) : null,
    action: b.action ? String(b.action) : null,
    actionDate: b.actionDate ? String(b.actionDate).slice(0, 10) : null,
    kmAtAction: b.kmAtAction != null ? Number(b.kmAtAction) || 0 : null,
    cost: b.cost != null ? String(Number(b.cost) || 0) : null,
    technician: b.technician ? String(b.technician) : null,
    workshop: b.workshop ? String(b.workshop) : null,
    notes: b.notes ? String(b.notes) : null,
  } as any).returning();
  return NextResponse.json(row);
}
