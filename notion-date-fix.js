#!/usr/bin/env node
/**
 * ★★★ Notion 重复任务日期自动修正（云端版）★★★
 * ══════════════════════════════════════════════════════════════
 *
 * 解决什么
 *   Notion 的重复模板在生成新条目时，会原样搬运模板里日期格的值。
 *   如果模板那格的日期被「提醒」固化过，之后每天复制出来的都是同一个死值，
 *   于是只能一天天手动改。这里自动把它改回来。
 *
 * 本脚本做什么
 *   把「自动生成」的条目日期修正为
 *       【该条目的生成当天（北京时间）】+ 【它原本的时刻】
 *   时刻原样保留 —— 那是你的提醒时间，不能动。
 *
 * ★ 与旧版最大的区别 ★
 *   旧版只处理「最新一批」，漏跑一天就永久漏掉。
 *   这一版扫描【最近 N 天内的全部批次】逐条判定
 *   → 漏跑一周，下次跑一次全部补齐；电脑关机完全不影响。
 *
 * 批次识别（两条独立证据，任一成立即认定）
 *   ① 名单命中：这一批里至少一条在「重复任务名单」里
 *   ② 冻结特征：这一批所有条目的日期都停在同一天，且那天 ≠ 生成日
 *      （手建任务不会整齐划一地停死在同一天）
 *
 * 自学习
 *   新认定的重复任务名会自动写回配置文件 → 你不用手动维护名单
 *
 * 用法
 *   node notion-date-fix.js                  # 干跑：只报告，不写
 *   node notion-date-fix.js --执行           # 真改
 *   node notion-date-fix.js --执行 --库=全局  # 换库
 *   node notion-date-fix.js --执行 --回溯=7  # 应急：补齐最近 7 天漏跑的
 *
 * ★★★ 处理范围（2026-11-06 按用户要求收窄）★★★ ★
 *   默认（--回溯=0）→ 【只处理今天生成的条目】★★
 *     · 判定：生成日 == 今天（北京时区）★
 *     · 只改「日期 < 生成日」的（过期的）→ 未来的不动 ★
 *     · ★ 精准、不扫历史、不误伤 ★
 *   应急：某天云端跑挂了 → 手动 --回溯=7 补那一周 ★
 *
 * 环境变量
 *   NOTION_TOKEN   Notion 集成令牌（云端必填；本地可省略，走 ~/.config/notion/token）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// ─────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────
const CFG_PATH = path.join(__dirname, "notion-date-fix.config.json");
let CFG = {
  库: "工作",
  最小批次: 3,
  批次间隔分钟: 5,
  重复任务名单: [],
  排除任务: [],
};
if (fs.existsSync(CFG_PATH)) {
  try {
    CFG = Object.assign(CFG, JSON.parse(fs.readFileSync(CFG_PATH, "utf8")));
  } catch (e) {
    console.error("配置文件解析失败（忽略）：" + e.message);
  }
}

const MIN_BATCH = CFG.最小批次 || 3;
const CLUSTER_GAP = (CFG.批次间隔分钟 || 5) * 60000;
let KNOWN_TASKS = Array.isArray(CFG.重复任务名单) ? CFG.重复任务名单.slice() : [];
const EXCLUDED = Array.isArray(CFG.排除任务) ? CFG.排除任务 : [];

// ─────────────────────────────────────────────
// 参数
// ─────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.some((a) => a === f || a.startsWith(f + "="));
const val = (f, d) => {
  const hit = argv.find((a) => a.startsWith(f + "="));
  return hit ? hit.slice(f.length + 1) : d;
};

const DRY = !has("--执行");
const LIB_NAME = val("--库", CFG.库 || "工作");
/**
 * ★★★ 扫描范围 ★★★
 *   默认 0 = 【只处理今天生成的条目】★★ ★
 *   ★ 2026-11-06 用户要求：「范围固定在当天生成的，别扫太大的范围」★
 *   ★ 精准：只动今天的 → 不会误伤历史条目 ★
 *   ★ 应急补齐：某天云端跑挂了 → 手动 --回溯=7 补那一周 ★
 */
const DAYS = parseInt(val("--回溯", "0"), 10) || 0;
const BACKFILL = val("--回补", "");

// ─────────────────────────────────────────────
// 库注册表
// ─────────────────────────────────────────────
const LIBS = {
  工作: {
    ds: "a1492bf9-b4d9-8346-a821-07d77eac236e",
    db: "9cd92bf9-b4d9-83e8-95dc-8124b6077790",
    label: "工作 / 任务·今日执行 / 待办清单",
  },
  全局: {
    ds: "ba492bf9-b4d9-8388-b838-87ed191b7541",
    db: "aa292bf9-b4d9-8237-81ef-813b367dfc78",
    label: "全局 / 待办清单",
  },
};
const lib = LIBS[LIB_NAME];
if (!lib) {
  console.error("未知库：" + LIB_NAME + "，可用：" + Object.keys(LIBS).join(" / "));
  process.exit(1);
}

// ─────────────────────────────────────────────
// 凭据
// ─────────────────────────────────────────────
function readToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN.trim();
  const paths = [
    path.join(os.homedir(), ".config", "notion", "token"),
    path.join(__dirname, "notion_token.txt"),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, "utf8").trim();
      if (t) return t;
    }
  }
  return "";
}
const TOKEN = readToken();
if (!TOKEN) {
  console.error("找不到 Notion 令牌。");
  console.error("  云端（GitHub Actions）：仓库 Settings → Secrets and variables → Actions → 加 NOTION_TOKEN");
  console.error("  本地：放到 " + path.join(os.homedir(), ".config", "notion", "token"));
  process.exit(1);
}

// ─────────────────────────────────────────────
// API
// ─────────────────────────────────────────────
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

async function queryAll() {
  const tries = [
    { url: "/databases/" + lib.db + "/query", ver: "2022-06-28" },
    { url: "/data_sources/" + lib.ds + "/query", ver: "2025-09-03" },
  ];
  let lastErr = null;
  for (const t of tries) {
    try {
      const out = [];
      let cursor = null, guard = 0;
      do {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const q = await api(t.url, "POST", body, t.ver);
        out.push(...(q.results || []));
        cursor = q.has_more ? q.next_cursor : null;
      } while (cursor && ++guard < 40);
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function readSchema() {
  for (const t of [
    { url: "/databases/" + lib.db, ver: "2022-06-28" },
    { url: "/data_sources/" + lib.ds, ver: "2025-09-03" },
  ]) {
    try {
      const d = await api(t.url, "GET", null, t.ver);
      const props = d.properties || {};
      let titleKey = null, dateKey = null;
      for (const k of Object.keys(props)) {
        const v = props[k];
        const type = v.type || (v[Object.keys(v)[0]] && Object.keys(v)[0]);
        if (type === "title" && !titleKey) titleKey = k;
        if (type === "date" && !dateKey) dateKey = k;
      }
      if (dateKey) return { titleKey, dateKey };
    } catch (e) { /* 试下一个 */ }
  }
  return { titleKey: null, dateKey: "日期" };
}

// ─────────────────────────────────────────────
// 时间工具（北京时间）
// ─────────────────────────────────────────────
const BJ_OFFSET = 8 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, "0");

function parseTs(s) {
  return new Date(String(s).replace(" ", "T")).getTime();
}

/** 规范化时间串 → 统一 ISO UTC（消除 Z / +00:00 差异，保证幂等） */
function normTs(s) {
  const d = new Date(String(s).replace(" ", "T"));
  if (isNaN(d.getTime())) return String(s);
  return d.toISOString();
}

/**
 * 解析日期值 → 北京时间的 { day, hm, hasTime }
 * ★ Notion 存的是 UTC 瞬时值，必须整体转成北京时间后重新组装，
 *   而不是「取 UTC 时刻减 8 小时」。
 */
function parseDateVal(start) {
  const s = String(start);
  if (s.indexOf("T") < 0) return { day: s.slice(0, 10), hm: null, hasTime: false };
  const shifted = new Date(parseTs(s) + BJ_OFFSET);
  return {
    day: shifted.getUTCFullYear() + "-" + pad(shifted.getUTCMonth() + 1) + "-" + pad(shifted.getUTCDate()),
    hm: pad(shifted.getUTCHours()) + ":" + pad(shifted.getUTCMinutes()),
    hasTime: true,
  };
}

/** 时间戳 → 北京时间 { day, hm } */
function bj(iso) {
  const d = new Date(parseTs(iso) + BJ_OFFSET);
  return {
    day: d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()),
    hm: pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()),
  };
}

/** 北京时间 day + hm → UTC ISO 串 */
function bjToIso(day, hm) {
  const [Y, M, D] = day.split("-").map(Number);
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.UTC(Y, M - 1, D, h, m) - BJ_OFFSET).toISOString();
}

function titleOf(p, titleKey) {
  const props = p.properties || {};
  const t = props[titleKey] || Object.values(props).find((v) => v && v.type === "title");
  if (!t) return "(无标题)";
  return (t.title || []).map((x) => x.plain_text).join("") || "(空标题)";
}

/** 创建时间相近的条目视为同一批 */
function clusterByCreation(items) {
  const sorted = items.slice().sort((a, b) => a.ts - b.ts);
  const clusters = [];
  let cur = null;
  for (const it of sorted) {
    if (!cur || it.ts - cur.lastTs > CLUSTER_GAP) {
      cur = { lastTs: it.ts, items: [it] };
      clusters.push(cur);
    } else {
      cur.items.push(it);
      cur.lastTs = it.ts;
    }
  }
  return clusters;
}

/**
 * 算出该条目应有的日期值
 *
 * ★ 时区保持一致 ★
 *   Notion 里同一条目可能存成 "+08:00"（Notion 原生写入）
 *   也可能存成 "+00:00"（脚本写入）。两种都能正确显示，
 *   但如果每次改写都把 +08:00 变成 +00:00，条目之间格式就不统一了。
 *   → 这里保留原值带的时区偏移，只换日期部分。
 */
function computeTarget(cur, genDay) {
  if (!cur || !cur.start) return null;
  const src = parseDateVal(cur.start);
  // ★★★ 2026-11-06：只修【过期】的（日期 < 生成日）★★★ ★
  //   ★ 日期已经等于生成日 → 正确，不动 ✔
  //   ★ 日期晚于生成日（未来）→ 不动（那不是「过期」，强行改反而错）★
  //   ★ 以前是「≠ 就改」→ 会把未来日期也拉回今天 → 过度修正 ★
  if (src.day >= genDay) return null;
  if (!src.hasTime) {
    return { start: genDay, label: genDay + "（纯日期）" };
  }
  const target = bjToIso(genDay, src.hm);
  if (normTs(cur.start) === normTs(target)) return null;
  return { start: target, label: genDay + " " + src.hm, hm: src.hm };
}

/**
 * 生成写回值：沿用原条目的时区偏移，只替换「日期 + 时刻」
 *
 *   原值 2026-11-04T16:00:00.000+08:00  →  新值 2026-11-06T16:00:00.000+08:00
 *   原值 2026-11-04T08:00:00.000+00:00  →  新值 2026-11-06T08:00:00.000+00:00
 */
function buildStartValue(origStart, genDay, hm) {
  const s = String(origStart);
  if (s.indexOf("T") < 0) return genDay;
  // 取出原值的时区偏移尾巴，如 "+08:00" / "Z" / ""
  const m = s.match(/([+-]\d{2}:\d{2}|Z)$/);
  const tz = m ? m[1] : "";
  // 用北京时间的 day+hm 算出 UTC 瞬时，再按原偏移拼回去
  const iso = bjToIso(genDay, hm);
  if (tz === "Z") return iso;
  if (tz) {
    const offMin = (parseInt(tz.slice(1, 3), 10) * 60 + parseInt(tz.slice(4, 6), 10)) * 60000;
    const shifted = new Date(new Date(iso).getTime() + offMin);
    return shifted.toISOString().replace("Z", "") + tz;
  }
  return iso;
}

/**
 * 批次内所有条目的日期是否整齐地停在同一天
 * （模板复制的典型特征；手建任务不会这样）
 */
function frozenFeature(cluster) {
  const days = new Set();
  for (const x of cluster.items) {
    if (!x.dv || !x.dv.start) return false;
    days.add(parseDateVal(x.dv.start).day);
  }
  if (days.size !== 1) return false;
  const only = [...days][0];
  // 那一天 ≠ 这一批的生成日 → 确实是冻住了
  return cluster.items.every((x) => x.genDay !== only);
}

/**
 * ★ 判定「这个标题是重复任务」的最可靠依据 ★
 *
 *   同一个标题出现在【多个不同的生成日】→ 它就是重复任务。
 *   这是重复任务的定义本身，不需要任何人工名单，
 *   所以名单丢了、GitHub 上第一次跑，都能自动认出来。
 *
 * @param {Map<string, Set<string>>} titleGenDays 标题 → 它出现过的生成日集合
 * @param {string} title
 */
function isRecurringTitle(titleGenDays, title) {
  const days = titleGenDays.get(title);
  return !!days && days.size >= 2;
}

/** 把新发现的重复任务名写回配置文件（自学习） */
function saveNewTasks(newNames) {
  if (!newNames.length) return 0;
  const list = KNOWN_TASKS.slice();
  let added = 0;
  for (const n of newNames) {
    if (!n || n === "(无标题)" || n === "(空标题)") continue;
    if (list.indexOf(n) >= 0) continue;
    list.push(n);
    added++;
  }
  if (!added) return 0;
  KNOWN_TASKS = list;
  try {
    const out = {};
    out._说明 = CFG._说明 || "Notion 重复任务日期自动修正的配置。改完直接生效，不用改脚本。";
    out.库 = CFG.库 || "工作";
    out.最小批次 = CFG.最小批次 || 3;
    out.批次间隔分钟 = CFG.批次间隔分钟 || 5;
    out.重复任务名单 = list;
    out.排除任务 = EXCLUDED;
    fs.writeFileSync(CFG_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
    return added;
  } catch (e) {
    console.log("  （名单自动保存失败：" + e.message.slice(0, 60) + "）");
    return 0;
  }
}

// ─────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────
(async () => {
  console.log("══════════════════════════════════════════════════════════");
  console.log("  Notion 重复任务日期自动修正 · " + (DRY ? "【干跑】只报告" : "【执行】会真实写入"));
  console.log("  库：" + lib.label);
  console.log("  扫描范围：" + (DAYS === 0 ? "★ 只今天生成的条目（精准模式）" : "最近 " + DAYS + " 天（应急补齐）"));
  console.log("══════════════════════════════════════════════════════════\n");

  let rows;
  try {
    rows = await queryAll();
  } catch (e) {
    console.error("✘ 查询失败：" + e.message);
    if (e.status === 404) {
      console.error("  → 这个库还没授权给 Obsidian Notes 集成（只需做一次）");
      console.error("    Notion → 打开「工作」页面 → 右上角 ··· → Connections → 选 Obsidian Notes → Confirm");
    }
    process.exit(1);
  }

  const { titleKey, dateKey } = await readSchema();
  const now = Date.now();
  // ★★★ 2026-11-06：cutoff 必须是【范围内起始那天的 00:00】★★★ ★
  //   ★ 原来 cutoff = now - DAYS*86400000 ★
  //   ★ DAYS=0 时 cutoff = now → 今天生成的条目全都早于 now → 被全排除！★
  //   → 自动生成 0 批 → 什么都不改 ★
  //   → 正确做法：从「范围内最早的那一天 00:00」开始 ★
  const todayBJ = bj(new Date(now).toISOString()).day;
  const allowedGenDays = new Set();
  for (let i = 0; i <= DAYS; i++) {
    // ★ bj() 要 ISO 字符串，直接传数字会得到 NaN ★
    allowedGenDays.add(bj(new Date(now - i * 86400000).toISOString()).day);
  }
  const earliestDay = [...allowedGenDays].sort()[0];
  const cutoff = parseTs(bjToIso(earliestDay, "00:00"));

  const items = rows.map((p) => {
    const props = p.properties || {};
    const dv = props[dateKey] && props[dateKey].date;
    const g = bj(p.created_time);
    return {
      id: p.id,
      ts: parseTs(p.created_time),
      title: titleOf(p, titleKey),
      dv: dv || null,
      genDay: g.day,
      genHm: g.hm,
    };
  });

  // ── 批次识别 ──
  // 先统计：每个标题出现在几个不同的生成日（重复任务的自证特征）
  const titleGenDays = new Map();
  for (const it of items) {
    if (!it.title) continue;
    if (!titleGenDays.has(it.title)) titleGenDays.set(it.title, new Set());
    titleGenDays.get(it.title).add(it.genDay);
  }

  const clusters = clusterByCreation(items);
  const autoIds = new Set();
  const clusterOf = new Map();
  const newNames = [];
  let nCluster = 0;

  for (const c of clusters) {
    if (!c.items.every((x) => x.ts >= cutoff && x.ts <= now + 60000)) continue;
    // ★★★ 范围限定：这一批必须在【允许的生成日】里 ★★★
    //   ★ 默认（回溯=0）→ 只有今天生成的才处理 → 精准、不碰历史条目 ★
    if (!c.items.every((x) => allowedGenDays.has(x.genDay))) continue;

    // ★★★ 2026-11-06 修：批次大小不再作为「一票否决」★★★ ★
    //   ★ 原逻辑：批次 < MIN_BATCH(3) → 整批 continue ★
    //   ★ 问题：Notion 分散生成时（每条隔十几分钟），批次凑不满 3 条 ★
    //     → 名单里的任务也被丢掉 → 日期不修正 ★
    //     ★ 实测 2026-11-06：拉伸/喝水/冥想/喝天麻粉 各自单独成批 → 全漏 ★
    //   ★ 改法：证据①（名单）和 ③（多日重复）都是【按标题】判定的 ★
    //     → 它们不依赖批次规模 → 批次再小也认 ★
    //   ★ 只有证据②（冻结特征）需要整批一起看 → 它才受批次规模限制 ★

    // 证据①：人工名单命中（★ 不受批次大小限制 ★）
    const byName = c.items.some((x) => KNOWN_TASKS.indexOf(x.title) >= 0);
    // 证据②：冻结特征（整批日期整齐停在同一天，且 ≠ 生成日）
    //   ★ 这个证据必须整批一起看 → 批次太小时不成立 ★
    const byFrozen = c.items.length >= MIN_BATCH && frozenFeature(c);
    // 证据③：这一批里的标题出现在多个不同生成日 → 它本身就是重复任务
    //   ★ 同样按标题判定 → 不受批次大小限制 ★
    const byRecurring = c.items.some((x) => isRecurringTitle(titleGenDays, x.title));

    if (!byName && !byFrozen && !byRecurring) continue;

    const why = byName ? "名单" : (byFrozen ? "冻结特征" : "多日重复");
    c.items.forEach((x) => {
      autoIds.add(x.id);
      clusterOf.set(x.id, { genDay: x.genDay, size: c.items.length, why });
      // 自学习：把这一批里出现的新任务名记下来
      if (x.title && KNOWN_TASKS.indexOf(x.title) < 0 &&
          newNames.indexOf(x.title) < 0) {
        newNames.push(x.title);
      }
    });
    nCluster++;
  }

  console.log("读到条目 " + rows.length + " 条");
  console.log("批次识别：" + clusters.length + " 批 → 认定为自动生成 " + nCluster +
    " 批（" + autoIds.size + " 条）");
  console.log("  名单 " + KNOWN_TASKS.length + " 个 · 冻结特征需批次 ≥ " + MIN_BATCH +
    " · 间隔 " + (CLUSTER_GAP / 60000) + " 分钟");
  console.log("  ★ 名单 / 多日重复 按标题判定 → 不受批次大小限制 ★");
  console.log("  ★★ 扫描范围：生成日 ∈ {" + [...allowedGenDays].sort().join(", ") + "}" +
    (DAYS === 0 ? "（只今天）" : "（回溯 " + DAYS + " 天）"));
  console.log("");

  // ── 逐条判定 ──
  const plan = [];
  const stats = { 已正确: 0, 非批次: 0, 排除: 0, 无日期: 0, 未来: 0, 范围外: 0 };

  for (const it of items) {
    if (!it.dv || !it.dv.start) { stats.无日期++; continue; }
    // ★★★ 范围外（生成日不在允许集合）→ 直接跳过，不进任何统计噪音 ★★★
    if (!allowedGenDays.has(it.genDay)) { stats.范围外++; continue; }
    if (!autoIds.has(it.id)) { stats.非批次++; continue; }
    if (it.ts > now + 60000) { stats.未来++; continue; }
    if (EXCLUDED.indexOf(it.title) >= 0) { stats.排除++; continue; }
    if (BACKFILL && it.genDay !== BACKFILL) { stats.非批次++; continue; }

    const target = computeTarget(it.dv, it.genDay);
    if (!target) { stats.已正确++; continue; }

    plan.push({
      id: it.id, title: it.title, genDay: it.genDay, genHm: it.genHm,
      old: it.dv.start, target,
      write: buildStartValue(it.dv.start, it.genDay, target.hm),
      why: (clusterOf.get(it.id) || {}).why || "",
    });
  }

  // ── 报告 ──
  console.log("──────────────────────────────────────────────────────────");
  console.log("扫描 " + rows.length + " 条 ｜ 范围内自动生成 " + autoIds.size +
    " ｜ 需修正 " + plan.length);
  console.log("  已正确 " + stats.已正确 + " ｜ 非自动生成 " + stats.非批次 +
    " ｜ 显式排除 " + stats.排除 + " ｜ 无日期 " + stats.无日期 +
    " ｜ 范围外 " + stats.范围外);
  console.log("──────────────────────────────────────────────────────────");

  if (plan.length) {
    console.log("");
    const byDay = {};
    for (const x of plan) (byDay[x.genDay] = byDay[x.genDay] || []).push(x);
    Object.keys(byDay).sort().forEach((d) => {
      console.log("【" + d + " 生成的一批】" + byDay[d].length + " 条需修正");
      byDay[d].forEach((x) => {
        console.log("   " + x.title.slice(0, 22).padEnd(24) +
          String(x.old).slice(0, 16) + "  →  " + x.target.label);
      });
      console.log("");
    });
  }
  if (newNames.length) {
    console.log("★ 新发现的重复任务（自动记入名单）：" + newNames.join("、"));
    console.log("");
  }

  if (!plan.length) {
    console.log("");
    console.log("✓ 没有需要修正的条目。");
    if (!DRY) {
      const added = saveNewTasks(newNames);
      if (added) console.log("  已把 " + added + " 个新任务名记入配置。");
    }
    return;
  }

  if (DRY) {
    console.log("【干跑结束】加 --执行 才会真正写入。");
    return;
  }

  // ── 写入 ──
  console.log("开始写入…");
  let ok = 0, fail = 0;
  for (const x of plan) {
    try {
      await api("/pages/" + x.id, "PATCH", {
        properties: { [dateKey]: { date: { start: x.write, time_zone: null } } },
      });
      const back = await api("/pages/" + x.id, "GET");
      const bd = back.properties[dateKey] && back.properties[dateKey].date;
      const b = bd && bd.start ? parseDateVal(bd.start) : null;
      const want = parseDateVal(x.target.start);
      if (b && b.day === want.day && b.hm === want.hm) {
        console.log("  ✔ " + x.title.slice(0, 20).padEnd(22) + " → " + b.day + (b.hm ? " " + b.hm : ""));
        ok++;
      } else {
        console.log("  ▲ " + x.title.slice(0, 20).padEnd(22) + " 回读不符：" +
          (bd && bd.start) + "（期望 " + x.target.start + "）");
        fail++;
      }
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      console.log("  ✘ " + x.title.slice(0, 20).padEnd(22) + " 失败：" + e.message.slice(0, 70));
      fail++;
    }
  }

  const added = saveNewTasks(newNames);
  if (added) console.log("已把 " + added + " 个新任务名记入配置。");

  console.log("");
  console.log("完成：成功 " + ok + " 条，失败 " + fail + " 条。");
  if (fail) console.log("提示：可重跑（幂等，已改对的不会再动）。");
})().catch((e) => {
  console.error("未预期错误：" + e.message);
  process.exit(1);
});
