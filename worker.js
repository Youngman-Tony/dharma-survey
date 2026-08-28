// Дхарма-тулкит — приёмник ответов опроса
// Cloudflare Worker + KV (free tier: 100k запросов/день)
//
// Деплой: см. README.md (раздел «Сбор ответов → Cloudflare Worker + KV»)
// Настройки (через Variables and Secrets в dashboard Cloudflare):
//   SURVEY_KV  — привязка KV namespace (обязательно)
//   ADMIN_KEY  — секретный ключ для доступа к /admin (обязательно)
//
// Эндпоинты:
//   POST /submit            — приём ответа с сайта (CORS разрешён)
//   GET  /admin?key=...     — HTML-список ответов
//   GET  /admin?key=...&format=csv  — CSV-файл
//   GET  /admin?key=...&format=json — JSON
//   GET  /admin?key=...&clear=1     — очистка всех ответов (после выгрузки)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const FIELD_ORDER = [
  "practice", "tradition", "school", "school_other", "years",
  "has_counting", "count_method", "count_method_other", "app_used",
  "dates_source", "dates_source_other", "dates_checked",
  "dates_conflict_details", "reading", "apps_tried",
  "interview", "interview_contact"
];

const FIELD_LABELS = {
  practice: "Практика", tradition: "Традиция", school: "Школа",
  school_other: "Школа (другое)", years: "Стаж", has_counting: "Счётные практики",
  count_method: "Способ счёта", count_method_other: "Способ счёта (другое)",
  app_used: "Приложение-счётчик", dates_source: "Источник дат",
  dates_source_other: "Источник дат (другое)", dates_checked: "Сверка дат",
  dates_conflict_details: "Расхождения дат", reading: "Чтение",
  apps_tried: "Приложения", interview: "Готовность к интервью",
  interview_contact: "Контакт"
};

function csvEscape(v) {
  const s = String(v === null || v === undefined ? "" : v);
  if (/[",;\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra }
  });
}

function checkAdmin(url, env) {
  return env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- CORS preflight ---
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // --- POST /submit: приём ответа ---
    if (url.pathname === "/submit" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return jsonResponse({ ok: false, error: "invalid_json" }, 400, CORS_HEADERS);
      }
      const answers = body && body.answers;
      if (!answers || typeof answers !== "object") {
        return jsonResponse({ ok: false, error: "no_answers" }, 400, CORS_HEADERS);
      }

      // Фильтрация: только известные поля, ограничение длины (анти-спам)
      const clean = {};
      for (const f of FIELD_ORDER) {
        if (answers[f] !== undefined && answers[f] !== null) {
          clean[f] = String(answers[f]).slice(0, 2000);
        }
      }
      if (Object.keys(clean).length === 0) {
        return jsonResponse({ ok: false, error: "empty" }, 400, CORS_HEADERS);
      }

      const ts = body.ts || new Date().toISOString();
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const key = "resp:" + ts + ":" + id;
      const record = { ts, id, answers: clean };

      await env.SURVEY_KV.put(key, JSON.stringify(record));

      return jsonResponse({ ok: true, id }, 200, CORS_HEADERS);
    }

    // --- /admin: выгрузка и очистка ---
    if (url.pathname === "/admin" && request.method === "GET") {
      if (!checkAdmin(url, env)) {
        return jsonResponse({ ok: false, error: "unauthorized" }, 401);
      }

      const list = await env.SURVEY_KV.list({ prefix: "resp:" });
      const records = [];
      for (const k of list.keys) {
        const raw = await env.SURVEY_KV.get(k.name);
        if (raw) {
          try { records.push(JSON.parse(raw)); } catch (e) {}
        }
      }
      records.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

      // CSV
      const header = ["timestamp", "id", ...FIELD_ORDER.map(f => FIELD_LABELS[f])];
      const rows = records.map(r => [
        r.ts, r.id, ...FIELD_ORDER.map(f => r.answers[f] || "")
      ]);
      const csv = "\uFEFF" + [header, ...rows]
        .map(row => row.map(csvEscape).join(";"))
        .join("\r\n");

      // CSV / JSON по формату
      const format = url.searchParams.get("format");
      if (format === "csv") {
        return new Response(csv, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="dharma-survey-responses.csv"'
          }
        });
      }
      if (format === "json") {
        return jsonResponse({ ok: true, count: records.length, records });
      }

      // Простая HTML-админка
      const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const keyParam = encodeURIComponent(env.ADMIN_KEY);
      const rowsHtml = records.map(r =>
        "<tr><td>" + esc(r.ts) + "</td><td>" + esc(r.id) + "</td>" +
        FIELD_ORDER.map(f => "<td>" + esc(r.answers[f] || "") + "</td>").join("") +
        "</tr>"
      ).join("");

      const html = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Дхарма-тулкит — ответы</title>
<style>
body{font-family:system-ui,sans-serif;margin:24px;background:#14100c;color:#e8dcc8}
h1{font-size:20px}table{border-collapse:collapse;width:100%;font-size:13px;margin-top:16px}
th{background:#3a2c1e;padding:6px 8px;text-align:left;border:1px solid #5a4a34;position:sticky;top:0}
td{padding:6px 8px;border:1px solid #3a2f22;vertical-align:top;max-width:280px;word-break:break-word}
.btns{margin:16px 0}a.btn,button.btn{display:inline-block;margin-right:12px;padding:10px 18px;background:#d4a017;color:#14100c;border:none;border-radius:8px;font-weight:700;text-decoration:none;cursor:pointer}
.stats{color:#bfa77a;font-size:14px}
</style></head><body>
<h1>☸ Дхарма-тулкит — ответы опроса</h1>
<p class="stats">Всего ответов: ${records.length}</p>
<div class="btns">
<a class="btn" href="?key=${keyParam}&format=csv">⬇ Скачать CSV</a>
<a class="btn" href="?key=${keyParam}&format=json">JSON</a>
<button class="btn" onclick="if(confirm('Удалить все ответы после выгрузки?'))location.href='?key=${keyParam}&clear=1'">Очистить хранилище</button>
</div>
<table><thead><tr><th>Дата</th><th>ID</th>${FIELD_ORDER.map(f => "<th>" + FIELD_LABELS[f] + "</th>").join("")}</tr></thead>
<tbody>${rowsHtml || "<tr><td colspan='19'>Пока нет ответов</td></tr>"}</tbody></table>
</body></html>`;

      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // --- DELETE /admin?clear=1: очистка ---
    if (url.pathname === "/admin" && request.method === "DELETE") {
      if (!checkAdmin(url, env)) {
        return jsonResponse({ ok: false, error: "unauthorized" }, 401);
      }
      const list = await env.SURVEY_KV.list({ prefix: "resp:" });
      for (const k of list.keys) await env.SURVEY_KV.delete(k.name);
      return jsonResponse({ ok: true, deleted: list.keys.length });
    }

    return jsonResponse({ ok: false, error: "not_found" }, 404);
  }
};