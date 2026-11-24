import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { verifyToken } from "@/lib/auth";
import { powerOf, ROLE_POWER } from "@/lib/guard";

export const dynamic = "force-dynamic";

function auth(req: NextRequest) {
  try { return verifyToken(req.cookies.get("fleet360_token")?.value || ""); } catch { return null; }
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const MAX_RECIPIENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_ATTACHMENT = /^data:(image\/(png|jpeg|webp)|application\/pdf);base64,/i;

export async function POST(req: NextRequest) {
  try {
    const user = auth(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // 🔒 الإرسال للمديرين فما فوق فقط (كان متاح لأي مستخدم مسجل)
    if (powerOf(user.role) < ROLE_POWER.admin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { to, subject, html, attachmentUrl, attachmentName } = body;

    if (!to || !subject || !html) {
      return NextResponse.json({ error: "بيانات الإيميل غير مكتملة" }, { status: 400 });
    }

    // 🔒 تحقق من المستلمين (عدد محدود، صيغة إيميل سليمة، من غير حقن headers)
    const recipients: string[] = (Array.isArray(to) ? to : String(to).split(/[;,]/))
      .map((x: unknown) => String(x).trim())
      .filter(Boolean);
    if (recipients.length === 0 || recipients.length > MAX_RECIPIENTS || !recipients.every((r) => EMAIL_RE.test(r))) {
      return NextResponse.json({ error: "المستلمين غير صحيحين" }, { status: 400 });
    }
    const safeSubject = String(subject).replace(/[\r\n]+/g, " ").slice(0, 200);

    // 🔒 بيانات حساب الإيميل لازم تتحط في Environment Variables (مفيش قيم افتراضية)
    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;
    if (!emailUser || !emailPass) {
      return NextResponse.json({ error: "خدمة الإيميل غير مفعّلة" }, { status: 503 });
    }

    const transporter = nodemailer.createTransport({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
      auth: { user: emailUser, pass: emailPass },
    });

    // 🔒 المرفقات: Base64 data-URI فقط (صور أو PDF) وبحد أقصى 5MB.
    // كان بيقبل أي path/URL، وده كان بيسمح بقراءة ملفات السيرفر (مثلاً /etc/passwd أو متغيرات البيئة) أو طلبات SSRF.
    let attachments: { filename: string; path: string }[] = [];
    if (attachmentUrl) {
      const data = String(attachmentUrl);
      if (!ALLOWED_ATTACHMENT.test(data) || data.length > MAX_ATTACHMENT_BYTES * 1.4) {
        return NextResponse.json({ error: "المرفق غير مسموح (صورة أو PDF فقط، حد أقصى 5MB)" }, { status: 400 });
      }
      const safeName = String(attachmentName || "invoice.png").replace(/[^\w.\-؀-ۿ ]/g, "_").slice(0, 100);
      attachments.push({ filename: safeName, path: data });
    }

    const info = await transporter.sendMail({
      from: `"Fleet360 System" <${emailUser}>`,
      to: recipients,
      subject: safeSubject,
      html: String(html),
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    return NextResponse.json({ success: true, message: "تم إرسال الإيميل بنجاح!", messageId: info.messageId }, { status: 200 });
  } catch (error: any) {
    console.error("Email Sending Error:", error);
    return NextResponse.json({ error: "فشل إرسال الإيميل" }, { status: 500 });
  }
}
