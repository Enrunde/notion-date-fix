#!/usr/bin/env node
/**
 * ★ Notion 自动修正 · 云端状态自检 ★
 * ══════════════════════════════════════════════════════════════
 *
 * 配好 GitHub Actions 后，跑这个脚本确认云端真的在工作：
 *   ① 本地脚本能连上 Notion 吗
 *   ② 云端定时任务配好了吗（从 GitHub API 查）
 *   ③ 现在有没有待修正的条目
 *
 * 用法
 *   node 检查云端状态.js
 *   node 检查云端状态.js --仓库=你的用户名/notion-date-fix
 *   （不传 --仓库 则跳过第②项检查）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const argv = process.argv.slice(2);
const val = (f, d) => {
  const hit = argv.find((a) => a.startsWith(f + "="));
  return hit ? hit.slice(f.length + 1) : d;
};
const REPO = val("--仓库", "");

const SCRIPT_DIR = __dirname;
const CFG_PATH = path.join(SCRIPT_DIR, "notion-date-fix.config.json");
let CFG = { 库: "工作" };
if (fs.existsSync(CFG_PATH)) {
  try { CFG = Object.assign(CFG, JSON.parse(fs.readFileSync(CFG_PATH, "utf8"))); }
  catch (e) { /* 忽略 */ }
}

function readToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN.trim();
  const p = path.join(os.homedir(), ".config", "notion", "token");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  return "";
}
const TOKEN = readToken();

const LIBS = {
  工作: { db: "9cd92bf9-b4d9-83e8-95dc-8124b6077790", ds: "a1492bf9-b4d9-8346-a821-07d77eac236e", label: "工作 / 任务·今日执行 / 待办清单" },
  全局: { db: "aa292bf9-b4d9-8237-81ef-813b367dfc78", ds: "ba492bf9-b4d9-8388-b838-87ed191b7541", label: "全局 / 待办清单" },
};
const lib = LIBS[CFG.库] || LIBS["工作"];

async function api(p, method, body, version) {
  const r = await fetch("https://api.notion.com/v1" + p, {
    method: method || "POST",
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Notion-Version": version || "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch (e) { j = { raw: txt.slice(0, 160) }; }
  if (!r.ok) {
    const err = new Error(String(j.message || j.raw || r.status));
    err.status = r.status;
    throw err;
  }
  return j;
}

function line(ok, title, detail) {
  const mark = ok === null ? "—" : (ok ? "✔" : "✘");
  const color = ok === null ? "" : (ok ? "\x1b[32m" : "\x1b[31m");
  const reset = ok === null ? "" : "\x1b[0m";
  console.log(color + mark + reset + " " + title + (detail ? "  →  " + detail : ""));
}

(async () => {
  console.log("\n══ Notion 自动修正 · 云端状态自检 ══\n");

  // ① 令牌
  if (!TOKEN) {
    line(false, "Notion 令牌", "未找到（本地：~/.config/notion/token）");
    process.exit(1);
  }
  line(true, "Notion 令牌", TOKEN.slice(0, 6) + "…" + TOKEN.slice(-4) + "（" + TOKEN.length + " 字符）");

  // ② 连通性
  let rows = [];
  try {
    for (const t of [
      { url: "/databases/" + lib.db + "/query", ver: "2022-06-28" },
      { url: "/data_sources/" + lib.ds + "/query", ver: "2025-09-03" },
    ]) {
      try {
        const q = await api(t.url, "POST", { page_size: 100 }, t.ver);
        rows = q.results || [];
        break;
      } catch (e) { /* 试下一个 */ }
    }
    line(true, "Notion 连通", lib.label + "，读到 " + rows.length + " 条");
  } catch (e) {
    line(false, "Notion 连通", e.message + (e.status === 404 ? "（该库未授权给集成）" : ""));
    process.exit(1);
  }

  // ③ 待修正情况（直接调主脚本的干跑）
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(SCRIPT_DIR, "notion-date-fix.js")], {
      encoding: "utf8",
      env: Object.assign({}, process.env, { NOTION_TOKEN: TOKEN }),
    });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  }
  const needMatch = out.match(/需修正\s+(\d+)/);
  const need = needMatch ? parseInt(needMatch[1], 10) : 0;
  const autoMatch = out.match(/认定为自动生成\s+\d+\s+批（(\d+)\s+条）/);
  line(need === 0, "待修正条目",
    need === 0 ? "0 条（一切正常）" : need + " 条（云端跑一次就会修好）");
  if (autoMatch) console.log("    自动生成批次共 " + autoMatch[1] + " 条在监控中");

  // ④ 云端工作流
  if (REPO) {
    try {
      const r = await fetch("https://api.github.com/repos/" + REPO + "/actions/workflows");
      const j = await r.json();
      if (j.workflows && j.workflows.length) {
        line(true, "GitHub 工作流", j.workflows.map((w) => w.name).join("、"));
      } else {
        line(null, "GitHub 工作流", "未查到（仓库需公开，或名字不对）");
      }
    } catch (e) {
      line(null, "GitHub 工作流", "查询失败：" + e.message.slice(0, 60));
    }
  } else {
    line(null, "GitHub 工作流", "未指定仓库（加 --仓库=用户名/仓库名 可检查）");
  }

  console.log("\n── 结论 ──");
  if (need === 0) {
    console.log("  Notion 里的日期目前都是对的。");
  } else {
    console.log("  有 " + need + " 条日期待修正。");
    console.log("  → 在 GitHub Actions 页面手动点一次 Run workflow 即可修好；");
    console.log("  → 之后每天凌晨 3:10 自动跑，电脑关机也不影响。");
  }
  console.log("");
})().catch((e) => {
  console.error("自检失败：" + e.message);
  process.exit(1);
});
