import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { JWTPayload } from "@/lib/auth";
import { canWrite, type Module } from "@/lib/permissions";

/** Returns a 403 response if the user may not write to this module, otherwise null. */
export function requireWrite(user: JWTPayload, module: Module) {
  return canWrite(user, module)
    ? null
    : NextResponse.json({ error: "ليس لديك صلاحية لهذا الإجراء" }, { status: 403 });
}

// تسلسل الأدوار (نفس القيم المستخدمة في باقي النظام)
export const ROLE_POWER: Record<string, number> = {
  owner: 4,
  super_admin: 3,
  admin: 2,
  user: 1,
};

export function powerOf(role?: string): number {
  return ROLE_POWER[role || "user"] ?? 1;
}

/** المالك والسوبر أدمن بيشوفوا كل الفروع (tenants) */
export function isGlobalUser(user: JWTPayload): boolean {
  return user.role === "owner" || user.role === "super_admin";
}

export function tenantOf(user: JWTPayload): string {
  return user.tenantId || "master";
}

/**
 * شرط SQL بيحصر العملية على فرع المستخدم (يمنع IDOR بين الفروع).
 * يستخدم في أي جملة على جدول فيه عمود tenant_id:
 *   WHERE id = ${id} AND ${tenantClause(user)}
 */
export function tenantClause(user: JWTPayload) {
  return isGlobalUser(user)
    ? sql`TRUE`
    : sql`COALESCE(tenant_id, 'master') = ${tenantOf(user)}`;
}
