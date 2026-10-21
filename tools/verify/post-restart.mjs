/**
 * 重启后的运行期验证：用**可判定的正向证据**证明补丁在新进程里生效。
 *
 * 设计原则（上一版被审计判 block 的四条结构缺陷，逐条对应修正）：
 *   1. 「新代码是否被加载」是硬性必填判据，不再因为没传参数就跳过。
 *      宿主启动时间默认从插件自己写的 `.codebuddy-host-heartbeat.json` 取
 *      （`registeredAt` + `pid`），那是运行中的宿主写的，不可伪造；只有心跳
 *      缺失时才要求显式传 `--host-started=`，此时仍会交叉校验合理性。
 *   2. 时间过滤按**记录时间**（`rec.time`），不是文件 mtime。会话日志是追加
 *      型，同一文件里有几小时前的记录，必须逐条比较下界。
 *   3. 判据要正向证据，不只「没看到错误码」：
 *      · 重启后至少有一次 provider 含 codebuddy 的请求（有尝试）
 *      · 重启后至少有一条 provider = codebuddy-cli 的 assistant 消息（真的 200 了）
 *      · 无 11128 / 11150（这才是「没失败」，与上一条合起来才成立）
 *   4. 补丁4（轮级归并）单独判定。判据是「本地请求数 vs 后台行数」的分离度，
 *      不是行数本身；分离度不足时明确标为「未验证」并以退出码 3 结束，绝不
 *      把未验证算成通过。
 *
 * 用法：
 *   node tools/verify/post-restart.mjs                 # 30 分钟窗口，自动读心跳
 *   node tools/verify/post-restart.mjs --minutes=60
 *   node tools/verify/post-restart.mjs --skip-merge    # 明确放弃补丁4 判定
 *
 * 参数：
 *   --minutes=<n>        回看窗口，默认 30
 *   --host-started=<ms>  宿主启动时间（默认从心跳文件推断）
 *   --dsh-home=<path>    DSH_HOME（默认 $DSH_HOME，再退 ~/.dsh）
 *   --max-sessions=<n>   最多扫多少个会话，默认 60（截断会告警）
 *   --page-size=<n>      后台明细分页大小，默认 500
 *   --skip-merge         跳过补丁4 判定（会打印醒目告警，退出码 0）
 *
 * 退出码：0 全部通过 / 1 有判据未通过 / 3 其余通过但补丁4 未验证 / 2 用法错误
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

// ── 参数 ──────────────────────────────────────────────────────
function arg(key, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${key}=`));
  return hit === undefined ? fallback : hit.slice(key.length + 3);
}
function flag(key) {
  return process.argv.slice(2).includes(`--${key}`);
}
function numArg(key, fallback) {
  const raw = arg(key, undefined);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`❌ --${key} 需要一个正数，收到 ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return n;
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** DSH_HOME：显式参数 > 环境变量（空白视为未设置）> ~/.dsh。与宿主规则一致。 */
function resolveDshHome() {
  const fromArg = arg("dsh-home", undefined);
  if (fromArg !== undefined && fromArg.trim() !== "") return resolve(fromArg);
  const fromEnv = process.env["DSH_HOME"];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv);
  return join(homedir(), ".dsh");
}

const DSH_HOME = resolveDshHome();
const MINUTES = numArg("minutes", 30);
const MAX_SESSIONS = numArg("max-sessions", 60);
const PAGE_SIZE = numArg("page-size", 500);
const SKIP_MERGE = flag("skip-merge");

// ── 结果计数 ──────────────────────────────────────────────────
let failures = 0;
let warnings = 0;
const notes = [];
function fail(msg) {
  console.log(`❌ ${msg}`);
  failures += 1;
}
function ok(msg) {
  console.log(`✅ ${msg}`);
}
function warn(msg) {
  console.log(`⚠️  ${msg}`);
  warnings += 1;
}
function info(msg) {
  console.log(`   ${msg}`);
}

// ── 复用一个轻依赖的插件导出面 ────────────────────────────────
// 只 import 纯函数（区域判定 / 凭据解析 / 身份头），不 apply 插件本体。
// 这样脚本与插件用的是**同一份**区域与凭据规则，不会各说各话。
let plugin = undefined;
try {
  plugin = await import(new URL("../../lib/index.js", import.meta.url).href);
} catch (error) {
  warn(`无法 import 插件的 lib/index.js（${error instanceof Error ? error.message : String(error)}），回退到内置规则`);
}
const regionOf = plugin?.regionOf;
const parseCodeBuddyAuth = plugin?.parseCodeBuddyAuth;
const defaultAuthDirCandidates = plugin?.defaultAuthDirCandidates;
const clientIdentityHeaders = plugin?.clientIdentityHeaders;
const resolveClientIdentity = plugin?.resolveClientIdentity;

/** 与 src/upstream.ts 的 billingBase() 同口径。 */
function billingBase(domain) {
  // 优先用插件自己的 regionOf，保证「global 判定」只有一处实现。
  const region = typeof regionOf === "function" ? regionOf(domain ?? "") : (String(domain ?? "").toLowerCase().endsWith("workbuddy.ai") ? "global" : "cn");
  return region === "global" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn";
}

// ── 凭据解析：accounts 存储 → 插件自有副本 → CLI 登录态 ───────
function credentialFromAccounts(file) {
  if (!existsSync(file)) return undefined;
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const bag = doc?.accounts;
  if (bag === null || typeof bag !== "object") return undefined;
  const id = typeof doc?.activeId === "string" && doc.activeId !== "" ? doc.activeId : undefined;
  const picks = id !== undefined && bag[id] !== undefined ? [bag[id]] : Object.values(bag);
  for (const account of picks) {
    const token = account?.accessToken;
    if (typeof token !== "string" || token === "") continue;
    return {
      accessToken: token,
      domain: typeof account.domain === "string" ? account.domain : "",
      uid: typeof account.uid === "string" ? account.uid : "",
      enterpriseId: typeof account.enterpriseId === "string" && account.enterpriseId !== "" ? account.enterpriseId : undefined,
      source: `accounts:${id ?? "(first)"}`,
    };
  }
  return undefined;
}

function credentialFromOwnCopy(file) {
  if (!existsSync(file)) return undefined;
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const stored = doc?.credential;
  const token = stored?.accessToken;
  if (typeof token !== "string" || token === "") return undefined;
  return {
    accessToken: token,
    domain: typeof stored.domain === "string" ? stored.domain : "",
    uid: typeof stored.uid === "string" ? stored.uid : "",
    enterpriseId: typeof stored.enterpriseId === "string" && stored.enterpriseId !== "" ? stored.enterpriseId : undefined,
    source: "own-copy",
  };
}

/** 扫 CLI 的 .info 文件；`Tencent-Cloud.coding-copilot.info` 优先，其次 mtime 最新。 */
function credentialFromCliAuth() {
  if (typeof parseCodeBuddyAuth !== "function" || typeof defaultAuthDirCandidates !== "function") return undefined;
  const CLI_FILE = "Tencent-Cloud.coding-copilot.info";
  let best;
  for (const dir of defaultAuthDirCandidates()) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".info")) continue;
      const path = join(dir, entry);
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const credential = parseCodeBuddyAuth(text);
      if (credential === undefined) continue;
      // 与 src/auth.ts 的 discoverInDir 同口径：CLI 自己的文件 rank=2，其余按 mtime。
      const rank = entry === CLI_FILE ? 2 : 0;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        // 无法 stat 时保留该凭据，rank 已足够排序。
      }
      const candidate = {
        accessToken: credential.accessToken,
        domain: credential.domain,
        uid: credential.uid,
        enterpriseId: credential.enterpriseId,
        source: `cli-auth:${entry}`,
        rank,
        mtimeMs,
      };
      if (best === undefined || candidate.rank > best.rank || (candidate.rank === best.rank && candidate.mtimeMs > best.mtimeMs)) {
        best = candidate;
      }
    }
  }
  return best;
}

function resolveCredential() {
  const tried = [];
  const stores = [
    ["accounts", () => credentialFromAccounts(join(DSH_HOME, ".codebuddy-cli-accounts.json"))],
    ["own-copy", () => credentialFromOwnCopy(join(DSH_HOME, ".codebuddy-cli-auth.json"))],
    ["cli-auth", credentialFromCliAuth],
  ];
  for (const [label, read] of stores) {
    let found;
    try {
      found = read();
    } catch (error) {
      tried.push(`${label}: 读取抛错 ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (found !== undefined) return { credential: found, tried };
    tried.push(`${label}: 无可用凭据`);
  }
  return { credential: undefined, tried };
}

// ── 会话日志读取（多帧 zstd）──────────────────────────────────
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const parseStats = { framesFailed: 0, linesFailed: 0, records: 0 };

/** 逐帧解压。解帧/解析失败要计数——静默丢弃会让「没看到错误码」变成假通过。 */
function readSessionRecords(file) {
  const buf = readFileSync(file);
  const starts = [];
  let idx = buf.indexOf(FRAME_MAGIC, 0);
  while (idx !== -1) {
    starts.push(idx);
    idx = buf.indexOf(FRAME_MAGIC, idx + 4);
  }
  const records = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length;
    let text;
    try {
      text = zstdDecompressSync(buf.subarray(from, to)).toString("utf8");
    } catch {
      // 末尾正在写入的那一帧最可能解不开——它恰好是最新的记录，必须报告。
      parseStats.framesFailed += 1;
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        parseStats.linesFailed += 1;
      }
    }
  }
  parseStats.records += records.length;
  return records;
}

function recentSessionFiles(minutes) {
  const cutoff = Date.now() - minutes * 60_000;
  const root = join(DSH_HOME, "sessions");
  const out = [];
  if (!existsSync(root)) return out;
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const wsDir = join(root, workspace.name);
    for (const session of readdirSync(wsDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const file = join(wsDir, session.name, "session.v4.jsonl.zstd");
      if (!existsSync(file)) continue;
      const st = statSync(file);
      // mtime 只用来**选文件**（少读），记录级过滤在下面按 rec.time 做。
      if (st.mtimeMs >= cutoff) out.push({ file, mtimeMs: st.mtimeMs, name: session.name });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// ── 1. 加载判据（硬性必填）────────────────────────────────────
console.log("── 1. 新代码是否被运行中的宿主加载 ──");

/** 心跳文件是**运行中的宿主**写的，比手工传的时间可信。 */
function readHostHeartbeat() {
  const file = join(DSH_HOME, ".codebuddy-host-heartbeat.json");
  if (!existsSync(file)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    if (typeof doc?.registeredAt !== "number" || typeof doc?.pid !== "number") return undefined;
    return { registeredAt: doc.registeredAt, pid: doc.pid, pluginVersion: doc.pluginVersion };
  } catch {
    return undefined;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const heartbeat = readHostHeartbeat();
const explicitStarted = Number(arg("host-started", "0"));
let hostStarted = 0;
if (Number.isFinite(explicitStarted) && explicitStarted > 0) {
  hostStarted = explicitStarted;
  info(`宿主启动时间（--host-started）: ${new Date(hostStarted).toLocaleString()}`);
} else if (heartbeat !== undefined) {
  // registeredAt 是插件在**当前宿主进程**里注册的时刻 ⇒ 一定晚于宿主启动。
  // 用它当下界是保守的：产物只要早于它，就必然被这个进程加载过。
  hostStarted = heartbeat.registeredAt;
  info(`宿主启动时间（心跳 registeredAt）: ${new Date(hostStarted).toLocaleString()}`);
  info(`心跳 pid=${heartbeat.pid} 存活=${pidAlive(heartbeat.pid)} 插件版本=${heartbeat.pluginVersion ?? "?"}`);
  if (!pidAlive(heartbeat.pid)) {
    warn(`心跳记录的 pid ${heartbeat.pid} 已不存在 ⇒ 心跳是**上一次**宿主留下的陈旧文件，下界不可信`);
    // 陈旧心跳不能当判据：清空，让下面走「必填」分支。
    hostStarted = 0;
  }
} else {
  info("心跳文件不存在");
}
if (hostStarted <= 0) {
  fail("无法确定宿主启动时间：心跳文件缺失或陈旧，且没有传 --host-started=<epochMs>");
  info("取值：Get-Process -Name 'DeepSeek Harness' | Sort-Object StartTime | Select-Object -First 1 StartTime");
}

// 产物取 lib 下**所有** js 的最大 mtime：构建是多文件，单文件不足以代表「新代码」。
const libDir = join(REPO_ROOT, "lib");
let builtAt = 0;
let artifactCount = 0;
if (!existsSync(libDir)) {
  fail(`找不到构建目录 ${libDir}`);
} else {
  for (const entry of readdirSync(libDir)) {
    if (!entry.endsWith(".js")) continue;
    const st = statSync(join(libDir, entry));
    artifactCount += 1;
    if (st.mtimeMs > builtAt) builtAt = st.mtimeMs;
  }
  if (artifactCount === 0) fail(`构建目录里没有 .js 产物：${libDir}`);
}
if (builtAt > 0) {
  info(`产物最新 mtime: ${new Date(builtAt).toLocaleString()}（${artifactCount} 个 .js）`);
  if (hostStarted > 0) {
    if (hostStarted > builtAt) ok("宿主启动晚于全部产物 ⇒ 新代码已加载");
    else fail("宿主启动早于产物 mtime ⇒ 新代码未加载，需要重启 DSH Desktop");
  }
}

// ── 2. 会话日志：按记录时间过滤后的取证 ───────────────────────
console.log("\n── 2. 会话日志（窗口内的记录级取证）──");
const files = recentSessionFiles(MINUTES);
if (files.length === 0) {
  fail(`近 ${MINUTES} 分钟内没有任何会话日志写入（${join(DSH_HOME, "sessions")}）`);
}
let scanned = files;
if (files.length > MAX_SESSIONS) {
  scanned = files.slice(0, MAX_SESSIONS);
  warn(`有 ${files.length} 个会话，只扫了最近 ${MAX_SESSIONS} 个 ⇒ 结果不完整（用 --max-sessions 放大）`);
}

/**
 * 逐会话按 seq 走，统计「上游请求次数」与「成功产出次数」。
 *
 * 关键事实（探针实测，不是推测）：`request/header` **不是每次请求都记**，
 * 它只在请求头发生变化时才落一条（`reason` 取值 `initial` / `change` / `resume` /
 * `series`）。本机一个 30586 条记录的会话里它只有 157 条，最后一条停在 09:54，
 * 之后就一直没有新记录——因为头没变。用它统计请求数会得到「重启后零请求」的
 * 假结论（这正是上一版的错）。
 *
 * 真正与「每次上游请求」一一对应的是 `step/start`（`data:{turn, step}`）。
 * 实测同一窗口内 `step/start` 与 `assistant/message` 数量基本相等（56 = 56，
 * 另一次 55 = 56，差额来自窗口边界与流式中断）。
 * 于是 provider 归属这样算：把 `request/header` 的 config 当作**当前生效头**
 * 向后携带（它只在变化时落盘，所以最后一条就是现行值），`step/start` 继承它。
 */
function collectEvidence(sessionFiles, lowerBound) {
  const requests = [];   // { at, session, turn, step }
  const badCodes = [];   // { code, session, turn, at }
  const successes = [];  // { session, turn, at, model }
  let sawCodebuddyProvider = false;
  let sawAssistantAny = false;
  let headerRecords = 0;
  for (const { file, name } of sessionFiles) {
    const records = readSessionRecords(file);
    records.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    let currentTurn = 0;
    // 当前生效的 provider：由最近一条 request/header 携带而来。
    let activeProvider = "";
    for (const rec of records) {
      if (rec.type === "request/header") {
        headerRecords += 1;
        const config = rec.data?.header?.config;
        const provider = config?.provider ?? rec.data?.header?.provider;
        if (typeof provider === "string" && provider !== "") activeProvider = provider;
        if (typeof provider === "string" && provider.includes("codebuddy")) sawCodebuddyProvider = true;
      }
      const at = typeof rec.time === "number" ? rec.time : 0;
      // 记录级时间过滤：早于宿主启动（或窗口下界）的一律不计。必须在读
      // provider 之后做——否则窗口前的 request/header 不会为窗口内的记录
      // 提供归属，会漏掉正确结果。
      if (at !== 0 && at < lowerBound) continue;
      if (rec.type === "assistant/message") {
        sawAssistantAny = true;
        const source = rec.data?.message?.source;
        const turn = typeof rec.data?.turn === "number" ? rec.data.turn : currentTurn;
        if (source?.provider === "codebuddy-cli") {
          successes.push({ session: name, turn, at, model: source.model ?? "?" });
        }
      } else if (rec.type === "step/start") {
        // step/start 自带 turn，比跟踪 turn/start 更直接。
        const turn = typeof rec.data?.turn === "number" ? rec.data.turn : currentTurn;
        if (typeof rec.data?.turn === "number") currentTurn = rec.data.turn;
        if (activeProvider.includes("codebuddy")) {
          requests.push({ at, session: name, turn, step: rec.data?.step });
        }
      } else if (rec.type === "turn/start" && typeof rec.data?.turn === "number") {
        currentTurn = rec.data.turn;
      }
      // 错误码可能落在任意记录里（错误以消息体、assistant 文本或 system/message 出现）。
      const text = typeof rec.data === "string" ? rec.data : JSON.stringify(rec.data ?? "");
      for (const code of ["11128", "11150"]) {
        if (text.includes(`"code":${code}`) || text.includes(`"code": ${code}`)) {
          badCodes.push({ code, session: name, turn: currentTurn, at });
        }
      }
    }
  }
  return { requests, badCodes, successes, sawCodebuddyProvider, sawAssistantAny, headerRecords };
}

const lowerBound = Math.max(hostStarted > 0 ? hostStarted : 0, Date.now() - MINUTES * 60_000);
info(`记录下界: ${new Date(lowerBound).toLocaleString()}`);
let evidence = { requests: [], badCodes: [], successes: [], sawCodebuddyProvider: false, sawAssistantAny: false };
if (files.length > 0) {
  evidence = collectEvidence(scanned, lowerBound);
  info(`扫了 ${scanned.length} 个会话 / ${parseStats.records} 条记录`);
  if (parseStats.framesFailed > 0) {
    warn(`有 ${parseStats.framesFailed} 个 zstd 帧解压失败（最可能包含最新记录）⇒ 结果可能不完整`);
  }
  if (parseStats.linesFailed > 0) {
    warn(`有 ${parseStats.linesFailed} 行 JSON 解析失败 ⇒ 结果可能不完整`);
  }
}

// 判据 2a：有尝试（正向）
if (files.length > 0) {
  if (evidence.requests.length > 0) {
    ok(`重启后有 ${evidence.requests.length} 次上游请求（按 step/start 统计，provider 含 codebuddy）`);
    if (evidence.headerRecords === 0) {
      warn("窗口内没有 request/header 记录（该事件只在请求头变化时落盘），provider 归属沿用了窗口前的最后一条");
    }
  } else {
    fail("重启后没有任何 provider 含 codebuddy 的上游请求 ⇒ 补丁路径根本没被走到，其余判据都没有意义");
  }
}
// 判据 2b：真的成功（正向）——这是「补丁生效」最强的一条
if (evidence.successes.length > 0) {
  const models = [...new Set(evidence.successes.map(s => s.model))].join(", ");
  ok(`重启后有 ${evidence.successes.length} 条 codebuddy-cli 的 assistant 消息（真的返回了 200，模型: ${models}）`);
  if (evidence.successes.length < evidence.requests.length) {
    info(`（请求 ${evidence.requests.length} 次 / 成功产出 ${evidence.successes.length} 条——差额可能是被取消或仍在流式中）`);
  }
} else if (evidence.requests.length > 0) {
  fail("有请求但没有任何 codebuddy-cli 的 assistant 消息 ⇒ 请求全部失败了");
}
// 判据 2c：无错误码（缺席证据，与 2a/2b 合起来才成立）
if (evidence.badCodes.length === 0) {
  ok("重启后的记录里没有 11128 / 11150");
} else {
  const detail = evidence.badCodes
    .slice(0, 6)
    .map(b => `${b.code}@${new Date(b.at).toLocaleTimeString()}/turn${b.turn}`)
    .join(", ");
  fail(`重启后仍出现被上游拒绝的错误码：${detail}${evidence.badCodes.length > 6 ? ` 等 ${evidence.badCodes.length} 处` : ""}`);
}

// ── 3. 补丁4：轮级归并的可判定判据 ────────────────────────────
console.log("\n── 3. 补丁4（轮级归并）──");
let mergeVerdict = "unverified";
let mergeDetail = "";
if (SKIP_MERGE) {
  warn("按 --skip-merge 跳过补丁4 判定：本次**没有验证**轮级归并");
  mergeDetail = "已按 --skip-merge 明确放弃";
} else if (evidence.requests.length === 0) {
  fail("没有本地请求可对比 ⇒ 补丁4 无法判定（先跑一轮 CodeBuddy 再重跑本脚本）");
  mergeDetail = "无本地请求";
} else {
  // 本地期望：未归并 = 每条请求一行；归并 = 每个 turn 一行。
  const turnKeys = new Set(evidence.requests.map(r => `${r.session}#${r.turn}`));
  const expectedUnmerged = evidence.requests.length;
  const expectedMerged = turnKeys.size;
  info(`本地: ${expectedUnmerged} 次请求分布在 ${expectedMerged} 个轮次`);

  const { credential, tried } = resolveCredential();
  if (credential === undefined) {
    warn(`读不到任何可用凭据（试过 ${tried.join(" | ")}）⇒ 补丁4 未验证`);
    mergeDetail = "无凭据";
  } else {
    info(`凭据来源: ${credential.source} | domain=${credential.domain || "(空)"} | region=${billingBase(credential.domain)}`);
    const pad = n => String(n).padStart(2, "0");
    const fmt = d =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const end = new Date();
    // 窗口比本地略宽，避免边界分钟被切掉；下面按 requestTime 逐行过滤。
    const start = new Date(lowerBound - 60_000);
    const base = billingBase(credential.domain);
    const headers = {
      "Authorization": credential.accessToken.startsWith("Bearer ") ? credential.accessToken : `Bearer ${credential.accessToken}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    };
    // 与插件 billingHeaders() 同口径：身份头、空值不发。
    if (typeof clientIdentityHeaders === "function" && typeof resolveClientIdentity === "function") {
      try {
        Object.assign(headers, clientIdentityHeaders(await resolveClientIdentity()));
      } catch {
        // 拿不到 CLI 版本时退化为不发版本头，与插件的降级一致。
      }
    }
    if (credential.uid !== "") headers["X-User-Id"] = credential.uid;
    if (credential.enterpriseId !== undefined) {
      headers["X-Enterprise-Id"] = credential.enterpriseId;
      headers["X-Tenant-Id"] = credential.enterpriseId;
    }
    if (credential.domain !== "") headers["X-Domain"] = credential.domain;

    let payload;
    let httpStatus;
    try {
      const res = await fetch(`${base}/billing/meter/get-user-request-usage`, {
        method: "POST",
        headers,
        body: JSON.stringify({ startTime: fmt(start), endTime: fmt(end), pageNum: 1, pageSize: PAGE_SIZE }),
        signal: AbortSignal.timeout(30_000),
      });
      httpStatus = res.status;
      const raw = await res.text();
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { __nonJson: raw.slice(0, 200) };
      }
    } catch (error) {
      fail(`后台明细请求失败：${error instanceof Error ? error.message : String(error)}`);
      mergeDetail = "后台不可达";
    }

    if (mergeDetail !== "") {
      // 网络层已失败，不再重复计一次失败。
    } else if (httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300)) {
      fail(`后台明细 HTTP ${httpStatus}：${JSON.stringify(payload ?? null).slice(0, 200)}`);
      mergeDetail = `HTTP ${httpStatus}`;
    } else if (payload?.code !== undefined && payload.code !== 0) {
      fail(`后台明细返回 code=${payload.code} msg=${payload.msg ?? "?"}`);
      mergeDetail = `code ${payload.code}`;
    } else {
      const rows = payload?.data?.data;
      if (!Array.isArray(rows)) {
        fail(`后台响应形状异常：${String(JSON.stringify(payload ?? null)).slice(0, 200)}`);
        mergeDetail = "响应形状异常";
      } else {
        const barMinute = fmt(start);
        const cliRows = rows.filter(r => {
          if (!(typeof r.client === "string" && r.client.toLowerCase() === "cli")) return false;
          // 逐行按 requestTime 过滤，避免把窗口外的行算进来。
          const t = typeof r.requestTime === "string" ? Date.parse(r.requestTime.replace(" ", "T")) : NaN;
          return !Number.isFinite(t) || t >= lowerBound || r.requestTime === barMinute;
        });
        info(`后台窗口内 ${rows.length} 行，其中 client=cli ${cliRows.length} 行`);
        if (cliRows.length === 0) {
          // 实测：后台按分钟聚合，且落账延迟以**小时**计。2026-10-21 15:26 查
          // 4 小时窗口（11:26–15:26），本地此间有 56 次上游请求，后台只有 1 行
          // 且是 11:26 的 CodeBuddyIDE 记录。所以「本窗口 0 行」不能说明任何事，
          // 也不能靠「稍后重跑」在几分钟内解决。
          warn("后台本窗口没有 client=cli 的行");
          info("实测后台落账延迟以小时计（同一 4 小时窗口内本地 56 次请求、后台仅 1 行且为更早的记录）");
          info("⇒ 本地无法在实时窗口内判定补丁4。权威判定请到 CodeBuddy 后台控制台的「调用记录」看同一轮是否只一条。");
          info("本地可确证的部分由单测钉死：同轮两次请求轮 id 相同、注入消息后 body 指纹确实变化。");
          mergeDetail = "后台落账延迟，本地无法判定";
        } else if (expectedUnmerged < 2 * expectedMerged) {
          // 平均每轮请求数太少，两种解释的结果接近，判不出来。
          warn(`本地平均每轮仅 ${(expectedUnmerged / expectedMerged).toFixed(1)} 次请求，归并与不归并的行数太接近 ⇒ 判不出来`);
          info("跑一个更长的轮次（多工具调用）再来判，分离度才够");
          mergeDetail = "分离度不足";
        } else if (cliRows.length <= expectedMerged * 1.5) {
          ok(`后台 ${cliRows.length} 行 ≈ 轮次数 ${expectedMerged}，远少于请求数 ${expectedUnmerged} ⇒ 轮级归并生效`);
          mergeVerdict = "merged";
          mergeDetail = `${cliRows.length} 行 / ${expectedMerged} 轮 / ${expectedUnmerged} 请求`;
        } else if (cliRows.length >= expectedUnmerged * 0.8) {
          fail(`后台 ${cliRows.length} 行 ≈ 请求数 ${expectedUnmerged}，远多于轮次数 ${expectedMerged} ⇒ 未归并（一轮被拆成多条）`);
          mergeVerdict = "unmerged";
          mergeDetail = `${cliRows.length} 行 / ${expectedMerged} 轮 / ${expectedUnmerged} 请求`;
        } else {
          warn(`后台 ${cliRows.length} 行落在 ${expectedMerged}（归并）与 ${expectedUnmerged}（未归并）之间 ⇒ 判不出来`);
          mergeDetail = `${cliRows.length} 行落在两者之间`;
        }
      }
    }
  }
}
if (mergeVerdict === "unverified" && failures === 0) {
  info("补丁4 的权威判定仍建议到 CodeBuddy 后台控制台核对「调用记录」是否同一轮只一条。");
  info("本地可确证的部分（会话头真的发出、同轮同一轮 id）由这些测试钉死：");
  info("  pnpm exec vitest run tests/adapter-compat.spec.ts tests/shim.spec.ts tests/turns.spec.ts");
}

// ── 汇总 ──────────────────────────────────────────────────────
console.log("");
if (failures > 0) {
  console.log(`${failures} 项未通过${warnings > 0 ? `，${warnings} 项告警` : ""}`);
  process.exitCode = 1;
} else if (mergeVerdict === "unverified" && !SKIP_MERGE) {
  console.log(`其余判据通过，但补丁4 未验证${warnings > 0 ? `（${warnings} 项告警）` : ""} —— 不要把它当成「全部通过」`);
  process.exitCode = 3;
} else {
  console.log(`全部通过${warnings > 0 ? `（${warnings} 项告警）` : ""}${mergeDetail !== "" ? ` | 补丁4: ${mergeDetail}` : ""}`);
  process.exitCode = 0;
}
