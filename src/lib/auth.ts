import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

// ⚠️ لا يوجد مفتاح افتراضي في الإنتاج: لازم JWT_SECRET يتحط في Environment Variables على Vercel
// (يفضّل 32 حرف عشوائي أو أكتر). في بيئة التطوير فقط بنستخدم مفتاح مؤقت.
function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV !== "production") return "dev-only-secret-do-not-use-in-production";
  throw new Error("JWT_SECRET is missing or too short (min 16 chars)");
}

export interface JWTPayload {
  userId: number;
  username: string;
  name?: string;
  role: string;
  permissions: string[];
  tenantId?: string;
}

export function signToken(payload: JWTPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: "24h", algorithm: "HS256" });
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, getSecret(), { algorithms: ["HS256"] }) as JWTPayload;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ── التحقق من الجلسة مقابل قاعدة البيانات ──
// التوكن بيحمل الدور والفرع لمدة 24 ساعة، فلو مستخدم اتحذف أو اتغيّر دوره/فرعه كان يفضل بصلاحياته القديمة.
// الدالة دي بتجيب بياناته الحالية من الـ DB (بكاش 15 ثانية لتخفيف الحمل):
//  - مستخدم محذوف => null (يعني 401)
//  - الدور والفرع والصلاحيات بتتاخد من الـ DB مش من التوكن
//  - لو الـ DB وقعت مؤقتاً بنرجع لبيانات التوكن عشان النظام ميوقفش
type FreshUser = { username: string; name: string; role: string | null; permissions: string | null; tenantId: string | null };
const sessionCache = new Map<number, { exp: number; data: FreshUser | null }>();
const SESSION_TTL_MS = 15_000;

export async function revalidateSession(payload: JWTPayload | null): Promise<JWTPayload | null> {
  if (!payload) return null;
  const now = Date.now();
  let fresh: FreshUser | null;
  const cached = sessionCache.get(payload.userId);
  if (cached && cached.exp > now) {
    fresh = cached.data;
  } else {
    try {
      const rows = await db
        .select({ username: users.username, name: users.name, role: users.role, permissions: users.permissions, tenantId: users.tenantId })
        .from(users)
        .where(eq(users.id, payload.userId))
        .limit(1);
      fresh = rows[0] ?? null;
      if (sessionCache.size > 1000) sessionCache.clear();
      sessionCache.set(payload.userId, { exp: now + SESSION_TTL_MS, data: fresh });
    } catch {
      return payload;
    }
  }
  if (!fresh) return null;
  let perms: string[] = payload.permissions;
  try { perms = JSON.parse(fresh.permissions || "[]"); } catch {}
  return {
    ...payload,
    username: fresh.username,
    name: fresh.name || payload.name,
    role: fresh.role || "user",
    tenantId: fresh.tenantId || "master",
    permissions: perms,
  };
}
