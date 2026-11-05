#!/usr/bin/env node
/**
 * ★ Notion 自动修正 · GitHub 一键部署 ★
 * ══════════════════════════════════════════════════════════════
 *
 * 自动完成：
 *   ① 创建公开仓库
 *   ② git 推送全部文件（.github/workflows/ 结构完整保留）
 *   ③ 配置 NOTION_TOKEN 加密 Secret
 *   ④ 触发一次 workflow 验证
 *
 * 前置：gh CLI 已登录（gh auth login）
 * 用法：node 部署到GitHub.js [仓库名]
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, execSync } = require("child_process");

const DIR = path.join(__dirname, "notion-date-fix");
const REPO_NAME = process.argv[2] || "notion-date-fix";

/**
 * 定位 gh 可执行文件
 * ★ 注意：Windows 上路径含反斜杠时，execFileSync 可能找不到文件
 *   → 统一转成正斜杠
 */
function findGh() {
  const cands = [];
  if (process.env.GH_PATH) cands.push(process.env.GH_PATH);
  cands.push(path.join(os.homedir(), "AppData", "Local", "Programs", "GitHub CLI", "bin", "gh.exe"));
  cands.push("/tmp/gh_cli/bin/gh.exe");
  cands.push("gh");
  for (const c of cands) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch (e) { /* 试下一个 */ }
  }
  return "gh";
}
const GH = findGh();

function readNotionToken() {
  const p = path.join(os.homedir(), ".config", "notion", "token");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  return "";
}
const NOTION_TOKEN = readNotionToken();

function gh(args, opts) {
  return execFileSync(GH, args, Object.assign({ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }, opts || {})).trim();
}
/** ghJson 只在输出确实是 JSON 时才解析；否则原样返回文本 */
function ghJson(args) {
  const out = gh(args);
  if (!out) return null;
  const t = out.trim();
  if (t[0] === "{" || t[0] === "[") {
    try { return JSON.parse(t); } catch (e) { return null; }
  }
  return t;
}
function git(args, cwd) {
  return execFileSync("git", args, Object.assign({
    encoding: "utf8", cwd: cwd, stdio: ["pipe", "pipe", "pipe"],
  })).trim();
}

const step = (s) => console.log("\n\x1b[36m▸ " + s + "\x1b[0m");
const ok = (s) => console.log("  \x1b[32m✔ " + s + "\x1b[0m");
const fail = (s) => console.log("  \x1b[31m✘ " + s + "\x1b[0m");
const info = (s) => console.log("    " + s);

(async () => {
  console.log("\n══ Notion 自动修正 · GitHub 一键部署 ══\n");

  // ① 身份
  step("检查 GitHub 登录状态");
  let user;
  try {
    user = ghJson(["api", "user", "--jq", ".login"]);
    if (!user) throw new Error("返回空");
  } catch (e) {
    fail("未登录 GitHub");
    console.log("");
    console.log("  调试信息：" + (e.stderr || e.message || "").toString().slice(0, 300));
    console.log("");
    console.log("  请在终端执行这一条，然后按提示用浏览器登录：");
    console.log('    "' + GH + '" auth login');
    console.log("");
    console.log("  选：GitHub.com → HTTPS → Yes(用浏览器登录) → 复制验证码");
    console.log("");
    process.exit(1);
  }
  ok("已登录：" + user);

  const full = user + "/" + REPO_NAME;

  // ② Notion 令牌
  step("检查 Notion 令牌");
  if (!NOTION_TOKEN) {
    fail("找不到 Notion 令牌");
    console.log("  期望位置：" + path.join(os.homedir(), ".config", "notion", "token"));
    process.exit(1);
  }
  ok("令牌已找到（" + NOTION_TOKEN.length + " 字符）");

  // ③ 仓库是否已存在
  step("检查仓库 " + full);
  let exists = false;
  try {
    ghJson(["api", "repos/" + full]);
    exists = true;
    ok("仓库已存在");
  } catch (e) {
    ok("仓库尚不存在（将新建）");
  }

  // ④ 准备本地 git
  step("准备本地仓库");
  const gitDir = path.join(os.tmpdir(), "notion-date-fix-git");
  if (fs.existsSync(gitDir)) {
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
  fs.mkdirSync(gitDir, { recursive: true });

  // 复制文件（含 .github 隐藏目录）
  const copyDir = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) copyDir(s, d);
      else fs.copyFileSync(s, d);
    }
  };
  copyDir(DIR, gitDir);
  const copied = [];
  const listDir = (d, base) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      const rel = base ? base + "/" + e.name : e.name;
      if (e.isDirectory()) listDir(f, rel); else copied.push(rel);
    }
  };
  listDir(gitDir, "");
  ok("已复制 " + copied.length + " 个文件到临时目录");
  copied.forEach((f) => info(f));

  // ⑤ git init + commit
  step("初始化 git 并提交");
  git(["init", "-b", "main"], gitDir);
  git(["config", "user.name", user], gitDir);
  git(["config", "user.email", user + "@users.noreply.github.com"], gitDir);
  git(["add", "-A"], gitDir);
  const msg = "feat: Notion 重复任务日期自动修正（云端版）";
  git(["commit", "-m", msg], gitDir);
  ok("本地提交完成");

  // ⑥ 建仓库 + 推送
  step("创建仓库并推送");
  if (!exists) {
    try {
      ghJson(["repo", "create", REPO_NAME, "--public",
        "--description", "Notion 重复任务日期自动修正（云端定时）",
        "--source", gitDir, "--remote", "origin", "--push"]);
      ok("仓库已创建并推送：" + full);
    } catch (e) {
      const msg2 = (e.stderr || e.message || "").toString();
      fail("创建/推送失败：" + msg2.slice(0, 300));
      process.exit(1);
    }
  } else {
    try {
      git(["remote", "remove", "origin"], gitDir);
    } catch (e) { /* 可能没有 */ }
    git(["remote", "add", "origin", "https://github.com/" + full + ".git"], gitDir);
    git(["push", "-u", "origin", "main", "--force"], gitDir);
    ok("已推送到现有仓库");
  }

  // ⑦ Secret
  step("配置 NOTION_TOKEN 加密 Secret");
  try {
    gh(["secret", "set", "NOTION_TOKEN", "--repo", full, "--body", NOTION_TOKEN]);
    ok("NOTION_TOKEN 已配置（GitHub 端加密存储）");
  } catch (e) {
    fail("Secret 配置失败：" + (e.stderr || e.message || "").toString().slice(0, 300));
    console.log("  手动补：https://github.com/" + full + "/settings/secrets/actions");
    console.log("  Name: NOTION_TOKEN   Value: " + NOTION_TOKEN);
  }

  // ⑧ 触发
  step("触发首次运行");
  try {
    // workflow 文件刚推上去，GitHub 需要几秒识别
    await new Promise((r) => setTimeout(r, 4000));
    gh(["workflow", "run", "notion-date-fix.yml", "--repo", full, "--ref", "main"]);
    ok("已触发，等待约 1 分钟");
  } catch (e) {
    fail("自动触发失败：" + (e.stderr || e.message || "").toString().slice(0, 200));
    console.log("  手动触发：https://github.com/" + full + "/actions");
  }

  console.log("\n══ 部署完成 ══\n");
  console.log("  仓库      https://github.com/" + full);
  console.log("  运行记录  https://github.com/" + full + "/actions");
  console.log("  密钥设置  https://github.com/" + full + "/settings/secrets/actions");
  console.log("");
  console.log("  从现在起：每天北京时间 03:10 自动修正。");
  console.log("  你的电脑关机 / 休眠 / 不开机，都不影响。");
  console.log("");
})().catch((e) => {
  console.error("\n部署失败：" + (e.stderr || e.message || "").toString().slice(0, 500));
  process.exit(1);
});
