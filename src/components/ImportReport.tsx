"use client";

import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Printer, Download, X, CheckCircle2, AlertTriangle, Link2 } from "lucide-react";
import { exportToExcel } from "@/lib/excel";

export interface ImportDetail {
  order: string;
  date: string | null;
  plate: string;
  equipment: string;
  equipmentDesc: string;
  description: string;
  category: string;
  cost: number;
  estimated: boolean;
  status: string; // جديد | محدث | غير مربوط
}

export interface ImportResult {
  total: number;
  inserted: number;
  updated: number;
  invalid?: number;
  duplicatesInFile?: number;
  byCategory: Record<string, { inserted: number; updated: number; cost: number }>;
  linkedVehicles: { equipment: string; plate: string }[];
  unmatched: { equipment: string; equipmentDesc: string; count: number }[];
  details: ImportDetail[];
}

const money = (n: number) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

const STATUS_STYLE: Record<string, string> = {
  "جديد": "bg-emerald-50 text-emerald-700 border-emerald-200",
  "محدث": "bg-blue-50 text-blue-700 border-blue-200",
  "غير مربوط": "bg-red-50 text-red-700 border-red-200",
};

export default function ImportReport({
  result,
  fileName,
  userName,
  onClose,
}: {
  result: ImportResult;
  fileName?: string;
  userName?: string;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [search, setSearch] = useState("");
  const [cat, setCat] = useState("الكل");
  const [status, setStatus] = useState("الكل");
  const createdAt = useMemo(() => new Date(), []);

  useEffect(() => {
    setMounted(true);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const details = result.details || [];
  const categories = Object.keys(result.byCategory || {});
  const filtered = details.filter((d) => {
    const q = search.trim().toLowerCase();
    const sMatch =
      !q ||
      d.order.includes(q) ||
      d.plate.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q) ||
      d.equipmentDesc.toLowerCase().includes(q);
    return sMatch && (cat === "الكل" || d.category === cat) && (status === "الكل" || d.status === status);
  });
  const filteredCost = filtered.reduce((a, d) => a + (d.cost || 0), 0);
  const importedCost = Object.values(result.byCategory || {}).reduce((a, c) => a + (c.cost || 0), 0);
  const unmatchedRows = details.filter((d) => d.status === "غير مربوط");

  const handleExcel = async () => {
    await exportToExcel(
      filtered.map((d) => ({
        "رقم SAP": d.order,
        "التاريخ": d.date || "",
        "رقم اللوحة": d.plate || "-",
        "Equipment": d.equipment,
        "بيان السيارة في SAP": d.equipmentDesc,
        "الوصف": d.description,
        "القسم": d.category,
        "التكلفة": d.cost,
        "تكلفة تقديرية": d.estimated ? "نعم" : "",
        "الحالة": d.status,
      })),
      `تقرير_استيراد_SAP_${createdAt.toISOString().slice(0, 10)}`
    );
  };

  if (!mounted) return null;

  return createPortal(
    <div id="import-report" className="fixed inset-0 z-[70] bg-gray-100 overflow-y-auto text-gray-900" dir="rtl">
      {/* toolbar */}
      <div className="no-print sticky top-0 z-10 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-black text-blue-900">تقرير استيراد شيت SAP</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => window.print()} className="flex items-center gap-2 px-4 py-2 bg-blue-900 hover:bg-blue-800 text-white rounded-xl font-bold text-sm cursor-pointer">
              <Printer size={16} /> طباعة / حفظ PDF
            </button>
            <button onClick={handleExcel} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-sm cursor-pointer">
              <Download size={16} /> تحميل Excel
            </button>
            <button onClick={onClose} className="flex items-center gap-1 px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-xl font-bold text-sm cursor-pointer">
              <X size={16} /> إغلاق
            </button>
          </div>
        </div>
      </div>

      <div className="report-body max-w-6xl mx-auto p-4 md:p-6 space-y-5">
        {/* header */}
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <h1 className="text-xl font-black text-blue-900">تقرير استيراد فواتير SAP — Fleet360</h1>
              <p className="text-xs text-gray-500 mt-1">
                {fileName ? `الملف: ${fileName} • ` : ""}
                {userName ? `بواسطة: ${userName} • ` : ""}
                {createdAt.toLocaleString("en-GB")}
              </p>
            </div>
            <div className="flex gap-4 text-center">
              <div><div className="text-2xl font-black text-gray-900">{result.total}</div><div className="text-[11px] text-gray-500 font-bold">فاتورة في الشيت</div></div>
              <div><div className="text-2xl font-black text-emerald-600">{result.inserted}</div><div className="text-[11px] text-gray-500 font-bold">جديدة</div></div>
              <div><div className="text-2xl font-black text-blue-600">{result.updated}</div><div className="text-[11px] text-gray-500 font-bold">محدثة</div></div>
              <div><div className="text-2xl font-black text-red-600">{unmatchedRows.length}</div><div className="text-[11px] text-gray-500 font-bold">لم تُربط</div></div>
            </div>
          </div>
        </div>

        {/* by category */}
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 font-black text-sm flex items-center gap-2">
            <CheckCircle2 size={16} className="text-emerald-600" /> التوزيع على الأقسام
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs">
              <tr><th className="text-right p-3">القسم</th><th className="p-3">جديد</th><th className="p-3">محدث</th><th className="text-left p-3">التكلفة (ج.م)</th></tr>
            </thead>
            <tbody>
              {categories.map((k) => {
                const c = result.byCategory[k];
                if (!c.inserted && !c.updated) return null;
                return (
                  <tr key={k} className="border-t border-gray-100">
                    <td className="p-3 font-bold">{k}</td>
                    <td className="p-3 text-center">{c.inserted}</td>
                    <td className="p-3 text-center">{c.updated}</td>
                    <td className="p-3 text-left font-mono font-bold">{money(c.cost)}</td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-gray-200 bg-gray-50 font-black">
                <td className="p-3">الإجمالي</td>
                <td className="p-3 text-center">{result.inserted}</td>
                <td className="p-3 text-center">{result.updated}</td>
                <td className="p-3 text-left font-mono">{money(importedCost)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* linked + unmatched */}
        {result.linkedVehicles?.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 p-5">
            <div className="font-black text-sm flex items-center gap-2 mb-3"><Link2 size={16} className="text-blue-600" /> سيارات اتربطت برقم SAP تلقائياً</div>
            <div className="flex flex-wrap gap-2">
              {result.linkedVehicles.map((l) => (
                <span key={l.equipment} className="text-xs font-bold bg-blue-50 text-blue-800 border border-blue-200 rounded-lg px-2.5 py-1">{l.plate} ← {l.equipment}</span>
              ))}
            </div>
          </div>
        )}

        {result.unmatched?.length > 0 && (
          <div className="bg-white rounded-2xl border border-red-200 p-5">
            <div className="font-black text-sm flex items-center gap-2 mb-1 text-red-700"><AlertTriangle size={16} /> فواتير لم تُستورد (السيارة غير موجودة في قائمة السيارات)</div>
            <p className="text-xs text-gray-500 mb-3">أضف هذه السيارات برقم SAP الخاص بها ثم أعد رفع نفس الشيت.</p>
            <table className="w-full text-sm">
              <thead className="bg-red-50 text-red-800 text-xs"><tr><th className="text-right p-2">رقم SAP للسيارة</th><th className="text-right p-2">بيان السيارة في SAP</th><th className="p-2">عدد الفواتير</th></tr></thead>
              <tbody>
                {result.unmatched.map((u) => (
                  <tr key={u.equipment} className="border-t border-gray-100"><td className="p-2 font-mono">{u.equipment}</td><td className="p-2">{u.equipmentDesc}</td><td className="p-2 text-center font-bold">{u.count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* details */}
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
            <div className="font-black text-sm">تفاصيل الفواتير ({filtered.length}) — {money(filteredCost)} ج.م</div>
            <div className="no-print flex flex-wrap items-center gap-2 text-xs">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث بالساب، اللوحة، الوصف..." className="border rounded-lg px-2.5 py-1.5 w-52 outline-none focus:border-teal-500" />
              <select value={cat} onChange={(e) => setCat(e.target.value)} className="border rounded-lg px-2 py-1.5">
                <option>الكل</option>
                {categories.map((k) => <option key={k}>{k}</option>)}
              </select>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className="border rounded-lg px-2 py-1.5">
                <option>الكل</option><option>جديد</option><option>محدث</option><option>غير مربوط</option>
              </select>
            </div>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-right p-2">#</th><th className="text-right p-2">رقم SAP</th><th className="text-right p-2">التاريخ</th>
                <th className="text-right p-2">اللوحة</th><th className="text-right p-2">الوصف</th><th className="text-right p-2">القسم</th>
                <th className="text-left p-2">التكلفة</th><th className="p-2">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, i) => (
                <tr key={d.order} className="border-t border-gray-100 align-top">
                  <td className="p-2 text-gray-400">{i + 1}</td>
                  <td className="p-2 font-mono font-bold text-blue-900">{d.order}</td>
                  <td className="p-2 font-mono whitespace-nowrap">{d.date || "-"}</td>
                  <td className="p-2 font-bold whitespace-nowrap">{d.plate || <span className="text-red-600">{d.equipment}</span>}</td>
                  <td className="p-2 leading-5">{d.description}</td>
                  <td className="p-2 whitespace-nowrap">{d.category}</td>
                  <td className="p-2 text-left font-mono font-bold whitespace-nowrap">{money(d.cost)}{d.estimated ? " *" : ""}</td>
                  <td className="p-2 text-center"><span className={`inline-block border rounded-md px-2 py-0.5 font-bold ${STATUS_STYLE[d.status] || ""}`}>{d.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {details.some((d) => d.estimated) && (
            <p className="text-[11px] text-gray-500 px-5 py-2 border-t border-gray-100">* تكلفة تقديرية: لا توجد تكلفة فعلية في SAP لهذه الفاتورة، فتم استخدام التكلفة التقديرية.</p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
