import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { verifyToken, revalidateSession } from "@/lib/auth";
import { ROLE_POWER, isGlobalUser, tenantOf } from "@/lib/guard";
import bcrypt from "bcryptjs";

export const dynamic = 'force-dynamic';

function auth(req: NextRequest) {
  try { return verifyToken(req.cookies.get("fleet360_token")?.value || ""); } catch { return null; }
}

const MIN_PASSWORD_LENGTH = 8;

function normalizePermissions(input: unknown, fallback: string): string {
  if (input === undefined || input === null) return fallback;
  try {
    const parsed = typeof input === "string" ? JSON.parse(input || "[]") : input;
    if (!Array.isArray(parsed)) return fallback;
    return JSON.stringify(parsed.filter((p) => typeof p === "string").slice(0, 100));
  } catch {
    return fallback;
  }
}

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> | { id: string } }) {
  try {
    const caller = await revalidateSession(auth(req));
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const params = await context.params;
    const targetUserId = Number(params.id);
    if (!targetUserId) return NextResponse.json({ error: "معرف غير صالح" }, { status: 400 });
    const body = await req.json().catch(() => ({}));

    const rawTarget = await db.execute(sql`SELECT * FROM users WHERE id = ${targetUserId}`);
    const targetUser = (rawTarget as any).rows?.[0] || (rawTarget as any)[0];
    if (!targetUser) return NextResponse.json({ error: "مستخدم غير موجود" }, { status: 404 });

    const callerPower = ROLE_POWER[caller.role] || 0;
    const targetPower = ROLE_POWER[targetUser.role] || 0;
    const isSelf = caller.userId === targetUserId;

    // ── تعديل مستخدم تاني ──
    if (!isSelf) {
      if (callerPower < ROLE_POWER.admin) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (targetPower === 4) {
        return NextResponse.json({ error: "لا يمكن المساس بحساب المالك (Owner)!" }, { status: 403 });
      }
      if (callerPower <= targetPower) {
        return NextResponse.json({ error: "صلاحياتك لا تسمح بتعديل هذا المستوى الإداري." }, { status: 403 });
      }
      // 🔒 المدير مقيّد بفرعه فقط (كان ممكن يعدّل مستخدمين فروع تانية)
      if (!isGlobalUser(caller) && (targetUser.tenant_id || "master") !== tenantOf(caller)) {
        return NextResponse.json({ error: "هذا المستخدم خارج نطاق فرعك" }, { status: 403 });
      }
    }

    // ── الدور ──
    // 🔒 كان الشرط بيتخطى لو المستخدم بيعدّل نفسه، فأي يوزر عادي كان يقدر يخلّي نفسه owner.
    // دلوقتي: المستخدم مينفعش يغيّر دوره أو صلاحياته أو اسم دخوله بنفسه.
    let role: string = targetUser.role;
    let permissions: string = targetUser.permissions || "[]";
    let username: string = targetUser.username;

    if (!isSelf) {
      if (body.role !== undefined && String(body.role) !== targetUser.role) {
        const requestedRole = String(body.role);
        if (!(requestedRole in ROLE_POWER)) {
          return NextResponse.json({ error: "دور غير صالح" }, { status: 400 });
        }
        if (ROLE_POWER[requestedRole] >= callerPower) {
          return NextResponse.json({ error: "لا يمكنك ترقية مستخدم لمستوى أعلى من مستواك أو مساوٍ لك." }, { status: 403 });
        }
        role = requestedRole;
      }
      permissions = normalizePermissions(body.permissions, permissions);
      const requestedUsername = String(body.username || "").trim().toLowerCase();
      if (requestedUsername) username = requestedUsername;
    }

    const name = String(body.name || "").trim() || targetUser.name;

    const updateData: any = { name, username, role, permissions };

    if (body.password && String(body.password).trim() !== "") {
      const newPassword = String(body.password).trim();
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return NextResponse.json({ error: `كلمة المرور لازم تكون ${MIN_PASSWORD_LENGTH} حروف على الأقل` }, { status: 400 });
      }
      updateData.password = await bcrypt.hash(newPassword, 10);
    }

    await db.update(users).set(updateData).where(eq(users.id, targetUserId));
    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (String(error?.message).includes("unique")) {
      return NextResponse.json({ error: "اسم المستخدم مسجل مسبقاً" }, { status: 400 });
    }
    console.error("PUT /api/users/[id] error:", error);
    return NextResponse.json({ error: "فشل التعديل" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> | { id: string } }) {
  try {
    const caller = await revalidateSession(auth(req));
    if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const params = await context.params;
    const targetUserId = Number(params.id);

    // منع حذف النفس
    if (caller.userId === targetUserId) {
      return NextResponse.json({ error: "لا يمكنك حذف حسابك الخاص!" }, { status: 400 });
    }

    const rawTarget = await db.execute(sql`SELECT * FROM users WHERE id = ${targetUserId}`);
    const targetUser = (rawTarget as any).rows?.[0] || (rawTarget as any)[0];
    if (!targetUser) return NextResponse.json({ error: "مستخدم غير موجود" }, { status: 404 });

    const callerPower = ROLE_POWER[caller.role] || 0;
    const targetPower = ROLE_POWER[targetUser.role] || 0;

    if (callerPower < ROLE_POWER.admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // لا أحد يحذف المالك (Owner)
    if (targetPower === 4) {
      return NextResponse.json({ error: "لا يمكن حذف حساب المالك (Owner)!" }, { status: 403 });
    }

    // لا يمكنك حذف شخص أعلى منك أو يساويك في المستوى
    if (callerPower <= targetPower) {
      return NextResponse.json({ error: "صلاحياتك لا تسمح بحذف هذا المستوى الإداري." }, { status: 403 });
    }

    // 🔒 المدير مقيّد بفرعه فقط
    if (!isGlobalUser(caller) && (targetUser.tenant_id || "master") !== tenantOf(caller)) {
      return NextResponse.json({ error: "هذا المستخدم خارج نطاق فرعك" }, { status: 403 });
    }

    await db.delete(users).where(eq(users.id, targetUserId));
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DELETE /api/users/[id] error:", error);
    return NextResponse.json({ error: "فشل الحذف" }, { status: 500 });
  }
}
