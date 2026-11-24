import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { signToken } from "@/lib/auth";
import bcrypt from "bcryptjs";

export const dynamic = 'force-dynamic';

// ── حماية ضد التخمين (Brute-force): 5 محاولات فاشلة = قفل 15 دقيقة لنفس (IP + اسم مستخدم) ──
// ملاحظة: التخزين في ذاكرة السيرفر (best-effort على Vercel Serverless). للحماية الكاملة استخدم Redis/Upstash.
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; first: number; lockedUntil: number }>();

function throttleKey(req: NextRequest, username: string) {
  const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  return `${ip}|${username}`;
}
function isLocked(key: string) {
  const a = attempts.get(key);
  return !!a && a.lockedUntil > Date.now();
}
function registerFailure(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || now - a.first > LOCK_MS) {
    attempts.set(key, { count: 1, first: now, lockedUntil: 0 });
    return;
  }
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) a.lockedUntil = now + LOCK_MS;
  if (attempts.size > 5000) attempts.clear();
}

// hash وهمي علشان وقت الرد يبقى متقارب سواء المستخدم موجود أو لأ
const DUMMY_HASH = bcrypt.hashSync("fleet360-dummy-password", 10);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "").trim();

    if (!username || !password) {
      return NextResponse.json({ error: "اسم المستخدم وكلمة المرور مطلوبان" }, { status: 400 });
    }

    const key = throttleKey(req, username);
    if (isLocked(key)) {
      return NextResponse.json({ error: "محاولات كتير غلط. حاول تاني بعد 15 دقيقة" }, { status: 429 });
    }

    const foundUsers = await db.select().from(users).where(eq(users.username, username)).limit(1);
    const user = foundUsers[0];

    if (!user) {
      try { await bcrypt.compare(password, DUMMY_HASH); } catch {}
      registerFailure(key);
      return NextResponse.json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" }, { status: 401 });
    }

    let isPasswordValid = false;
    try { isPasswordValid = await bcrypt.compare(password, user.password); } catch { isPasswordValid = false; }

    if (!isPasswordValid && (user.password === password || user.password === String(password))) {
      isPasswordValid = true;
      try {
        const hashed = await bcrypt.hash(password, 10);
        await db.update(users).set({ password: hashed }).where(eq(users.id, user.id));
      } catch (err) {}
    }

    if (!isPasswordValid) {
      registerFailure(key);
      return NextResponse.json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" }, { status: 401 });
    }
    attempts.delete(key);

    let perms: string[] = [];
    try { perms = JSON.parse(user.permissions || "[]"); } catch {}

    // ✅ إضافة الـ tenantId للتوكن لفصل بيانات هذا اليوزر عن غيره
    const token = signToken({
      userId: user.id,
      username: user.username,
      name: user.name,
      role: user.role || "user",
      permissions: perms,
      tenantId: user.tenantId || "master", // 👈 السر هنا
    });

    const response = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        permissions: perms,
        tenantId: user.tenantId || "master",
      },
    });

    response.cookies.set("fleet360_token", token, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 60 * 60 * 24, path: "/",
    });

    return response;
  } catch (error: any) {
    return NextResponse.json({ error: "حدث خطأ أثناء تسجيل الدخول" }, { status: 500 });
  }
}
