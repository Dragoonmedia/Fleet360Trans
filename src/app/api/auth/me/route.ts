import { NextRequest, NextResponse } from "next/server";
import { verifyToken, revalidateSession } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const token = req.cookies.get("fleet360_token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const payload = await revalidateSession(verifyToken(token));
  if (!payload) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ user: payload });
}
