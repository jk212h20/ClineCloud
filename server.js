/**
 * ClineCloud v1.0 — Cloud-hosted Cline Server
 * 
 * Accepts tasks from websites (EveryVPoker admin, etc.) via WebSocket,
 * runs Cline CLI against git-cloned project repos, streams progress back,
 * and pushes changes to GitHub when done.
 * 
 * Adapted from PhoneConnectionToCline/server.js (Cline Remote v4.0)
 */

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import fs from "fs";
import http from "http";
import https from "https";
import git from "isomorphic-git";
import gitHttp from "isomorphic-git/http/node/index.js";

const { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync } = fs;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "3000", 10);
const PIN = process.env.PIN || "1234";
const CLINE_PATH = process.env.CLINE_PATH || "cline";
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || "10", 10);
const DEFAULT_TIMEOUT = parseInt(process.env.DEFAULT_TIMEOUT || "600", 10);
const GH_TOKEN = process.env.GH_TOKEN || "";
const DATA_DIR = process.env.DATA_DIR || "/data";
const REPOS_DIR = join(DATA_DIR, "repos");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Projects config — loaded from /data/projects.json or env
const PROJECTS_JSON = process.env.PROJECTS_JSON || join(DATA_DIR, "projects.json");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let activeProcess = null;
let activeTask = null;
const taskQueue = [];
const taskLog = [];
const authenticatedClients = new Set();
let taskCounter = 0;

// Conversation continuation — track last Cline task ID per CWD
const CONV_STATE_FILE = join(DATA_DIR, "conversation-state.json");
const lastClineTaskIdByCwd = loadConversationState();
let currentClineTaskId = null;

function loadConversationState() {
  try {
    if (existsSync(CONV_STATE_FILE)) {
      const data = JSON.parse(readFileSync(CONV_STATE_FILE, "utf-8"));
      return new Map(Object.entries(data));
    }
  } catch (e) {
    console.log("[conv] Failed to load conversation state:", e.message);
  }
  return new Map();
}

function saveConversationState() {
  try {
    const obj = Object.fromEntries(lastClineTaskIdByCwd);
    writeFileSync(CONV_STATE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.log("[conv] Failed to save conversation state:", e.message);
  }
}

// Heartbeat / watchdog
let lastOutputTime = null;
let watchdogInterval = null;
let heartbeatInterval = null;
let taskStartTime = null;
let lastEventType = null;
let apiCallCount = 0;
let totalCost = 0;
let currentModel = null;

const WATCHDOG_WARN_MS = 300_000;
const WATCHDOG_STALL_MS = 600_000;

// Output buffer for reconnect replay
const OUTPUT_BUFFER_SIZE = 200;
let outputBuffer = [];
let outputBufferTaskId = null;

// Conversation continuation — skip replayed history during resume
let isReplayingHistory = false;

// Streaming text batching
let streamingText = "";
let streamingTimer = null;
const STREAM_BATCH_MS = 150;

function pushToOutputBuffer(msg) {
  outputBuffer.push(msg);
  if (outputBuffer.length > OUTPUT_BUFFER_SIZE) outputBuffer.shift();
}

function clearOutputBuffer() {
  outputBuffer = [];
  outputBufferTaskId = null;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------
function ensureReposDir() {
  if (!existsSync(REPOS_DIR)) {
    mkdirSync(REPOS_DIR, { recursive: true });
    console.log(`[git] Created repos directory: ${REPOS_DIR}`);
  }
}

function getRepoDir(projectKey) {
  return join(REPOS_DIR, projectKey);
}

// Auth helper for isomorphic-git
function gitAuth() {
  if (!GH_TOKEN) return {};
  return {
    onAuth: () => ({ username: GH_TOKEN, password: "x-oauth-basic" }),
  };
}

async function gitCloneOrPull(repoUrl, projectKey) {
  const repoDir = getRepoDir(projectKey);
  
  if (existsSync(join(repoDir, ".git"))) {
    // Pull latest via fetch + checkout
    console.log(`[git] Pulling latest for ${projectKey}...`);
    try {
      await git.fetch({ fs, http: gitHttp, dir: repoDir, ...gitAuth() });
      // Get the default branch
      const branches = await git.listBranches({ fs, dir: repoDir, remote: "origin" });
      const defaultBranch = branches.includes("main") ? "main" : branches.includes("master") ? "master" : branches[0];
      // Fast-forward merge: checkout the remote branch
      await git.checkout({ fs, dir: repoDir, ref: defaultBranch });
      await git.merge({ fs, dir: repoDir, theirs: `origin/${defaultBranch}`, fastForward: true, author: { name: "ClineCloud", email: "cline@clinecloud.dev" } });
      console.log(`[git] Pull complete for ${projectKey}`);
    } catch (e) {
      console.log(`[git] Pull failed for ${projectKey}: ${e.message}, trying hard reset...`);
      try {
        await git.fetch({ fs, http: gitHttp, dir: repoDir, ...gitAuth() });
        const branches = await git.listBranches({ fs, dir: repoDir, remote: "origin" });
        const defaultBranch = branches.includes("main") ? "main" : "master";
        // Get the remote commit
        const remoteRef = await git.resolveRef({ fs, dir: repoDir, ref: `refs/remotes/origin/${defaultBranch}` });
        // Force checkout to that commit
        await git.checkout({ fs, dir: repoDir, ref: defaultBranch, force: true });
        console.log(`[git] Force checkout to origin/${defaultBranch} for ${projectKey}`);
      } catch (e2) {
        console.error(`[git] Reset also failed: ${e2.message}`);
      }
    }
  } else {
    // Clone
    console.log(`[git] Cloning ${projectKey} via isomorphic-git...`);
    try {
      mkdirSync(repoDir, { recursive: true });
      await git.clone({
        fs,
        http: gitHttp,
        dir: repoDir,
        url: repoUrl,
        singleBranch: true,
        depth: 1,
        ...gitAuth(),
      });
      console.log(`[git] Cloned ${projectKey}`);
    } catch (e) {
      console.error(`[git] Clone failed for ${projectKey}: ${e.message}`);
      throw e;
    }
  }
  
  return repoDir;
}

async function gitPushChanges(repoDir, projectKey, taskSummary) {
  try {
    // Check for changes using isomorphic-git statusMatrix
    const matrix = await git.statusMatrix({ fs, dir: repoDir });
    const changed = matrix.filter(([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1);
    
    if (changed.length === 0) {
      console.log(`[git] No changes to push for ${projectKey}`);
      return { pushed: false, reason: "no changes" };
    }
    
    // Stage all changes
    for (const [filepath, , workdir] of changed) {
      if (workdir === 0) {
        await git.remove({ fs, dir: repoDir, filepath });
      } else {
        await git.add({ fs, dir: repoDir, filepath });
      }
    }
    
    const summary = (taskSummary || "ClineCloud task").substring(0, 72);
    await git.commit({
      fs,
      dir: repoDir,
      message: `ClineCloud: ${summary}`,
      author: { name: "ClineCloud", email: "cline@clinecloud.dev" },
    });
    
    await git.push({
      fs,
      http: gitHttp,
      dir: repoDir,
      ...gitAuth(),
    });
    
    console.log(`[git] Pushed changes for ${projectKey}`);
    return { pushed: true };
  } catch (e) {
    console.error(`[git] Push failed for ${projectKey}: ${e.message}`);
    return { pushed: false, reason: e.message };
  }
}

// ---------------------------------------------------------------------------
// Projects registry
// ---------------------------------------------------------------------------
function loadProjects() {
  try {
    if (existsSync(PROJECTS_JSON)) {
      return JSON.parse(readFileSync(PROJECTS_JSON, "utf-8"));
    }
  } catch (e) {
    console.log("[projects] Failed to load:", e.message);
  }
  return {};
}

function saveProjects(projects) {
  try {
    mkdirSync(dirname(PROJECTS_JSON), { recursive: true });
    writeFileSync(PROJECTS_JSON, JSON.stringify(projects, null, 2));
  } catch (e) {
    console.log("[projects] Failed to save:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({
  status: "ok",
  version: "1.2.0",
  type: "cline-cloud",
  gitEngine: "isomorphic-git",
  activeTask: activeTask ? { id: activeTask.id, project: activeTask.projectKey } : null,
  queueLength: taskQueue.length,
}));

// List projects
app.get("/api/projects", (req, res) => {
  const projects = loadProjects();
  res.json({ projects });
});

// Register a project (called during setup)
app.post("/api/projects", async (req, res) => {
  const { key, repo, liveUrl, hotLoadUrl, description } = req.body;
  if (!key || !repo) return res.status(400).json({ error: "key and repo required" });
  
  const projects = loadProjects();
  projects[key] = { repo, liveUrl, hotLoadUrl, description, addedAt: new Date().toISOString() };
  saveProjects(projects);
  
  // Clone immediately
  try {
    ensureReposDir();
    await gitCloneOrPull(repo, key);
    res.json({ ok: true, repoDir: getRepoDir(key) });
  } catch (e) {
    res.status(500).json({ error: `Clone failed: ${e.message}` });
  }
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let isAuthenticated = false;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (msg.type === "auth") {
      if (msg.pin === PIN) {
        isAuthenticated = true;
        authenticatedClients.add(ws);
        ws.send(JSON.stringify({ type: "auth", success: true }));
        sendState(ws);
        if (activeTask && outputBuffer.length > 0) {
          for (const m of outputBuffer) ws.send(JSON.stringify(m));
        }
      } else {
        ws.send(JSON.stringify({ type: "auth", success: false, message: "Wrong PIN" }));
      }
      return;
    }

    if (!isAuthenticated) {
      ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
      return;
    }

    switch (msg.type) {
      case "submit-task": handleSubmitTask(ws, msg); break;
      case "cancel-task": handleCancelTask(ws, msg); break;
      case "get-state": sendState(ws); break;
      case "task-respond": handleTaskRespond(ws, msg); break;
      case "list-projects": handleListProjects(ws); break;
      case "clear-conversation": {
        const cwd = msg.cwd || "";
        lastClineTaskIdByCwd.delete(cwd);
        saveConversationState();
        ws.send(JSON.stringify({ type: "conversation-cleared", cwd }));
        break;
      }
      default:
        ws.send(JSON.stringify({ type: "error", message: `Unknown: ${msg.type}` }));
    }
  });

  ws.on("close", () => authenticatedClients.delete(ws));
});

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of authenticatedClients) {
    if (c.readyState === 1) c.send(data);
  }
  if (msg.type !== "status" && msg.type !== "heartbeat") {
    pushToOutputBuffer(msg);
  }
}

function sendState(ws) {
  const projects = loadProjects();
  ws.send(JSON.stringify({
    type: "state",
    activeTask: activeTask ? { id: activeTask.id, prompt: activeTask.prompt, cwd: activeTask.cwd, project: activeTask.projectKey } : null,
    queueLength: taskQueue.length,
    recentTasks: taskLog.slice(-20).reverse(),
    projects: Object.keys(projects),
    model: currentModel,
    apiCallCount,
    totalCost,
  }));
}

// ---------------------------------------------------------------------------
// Task submission
// ---------------------------------------------------------------------------
async function handleSubmitTask(ws, msg) {
  const prompt = (msg.prompt || "").trim();
  if (!prompt) { ws.send(JSON.stringify({ type: "error", message: "Empty prompt" })); return; }

  // Determine project and CWD
  const projectKey = msg.project || msg.projectKey || "";
  let cwd = msg.cwd || "";
  
  if (projectKey) {
    const projects = loadProjects();
    const proj = projects[projectKey];
    if (!proj) {
      ws.send(JSON.stringify({ type: "error", message: `Unknown project: ${projectKey}. Register it first via POST /api/projects` }));
      return;
    }
    
    // Ensure repo is cloned and up to date
    try {
      ensureReposDir();
      cwd = await gitCloneOrPull(proj.repo, projectKey);
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: `Git setup failed: ${e.message}` }));
      return;
    }
  } else if (cwd) {
    // Direct CWD mode (less common for cloud)
    if (!existsSync(cwd)) {
      ws.send(JSON.stringify({ type: "error", message: `CWD does not exist: ${cwd}` }));
      return;
    }
  } else {
    ws.send(JSON.stringify({ type: "error", message: "Either 'project' or 'cwd' is required" }));
    return;
  }

  // Handle "new conversation"
  if (msg.newConversation) {
    lastClineTaskIdByCwd.delete(cwd);
  }

  const continueTaskId = lastClineTaskIdByCwd.get(cwd) || msg.resumeTaskId || null;

  taskCounter++;
  const task = {
    id: `task-${taskCounter}`,
    prompt,
    cwd,
    projectKey,
    mode: msg.mode === "plan" ? "plan" : "act",
    yolo: msg.yolo !== false,
    timeout: msg.timeout || DEFAULT_TIMEOUT,
    model: (msg.model || "").trim(),
    continueTaskId,
    autoPush: msg.autoPush !== false, // Default: push changes after completion
  };

  if (activeProcess) {
    if (taskQueue.length >= MAX_QUEUE_SIZE) {
      ws.send(JSON.stringify({ type: "error", message: "Queue full" }));
      return;
    }
    taskQueue.push(task);
    broadcast({ type: "queued", taskId: task.id, prompt: task.prompt, position: taskQueue.length });
  } else {
    startTask(task);
  }
}

// ---------------------------------------------------------------------------
// Start task
// ---------------------------------------------------------------------------
function startTask(task) {
  activeTask = task;
  clearOutputBuffer();
  outputBufferTaskId = task.id;
  lastEventType = "starting";
  apiCallCount = 0;
  totalCost = 0;
  currentModel = null;
  streamingText = "";
  currentClineTaskId = null;

  isReplayingHistory = !!task.continueTaskId;
  if (isReplayingHistory) {
    setTimeout(() => {
      if (isReplayingHistory) {
        console.log(`[${task.id}] History replay safety timeout — forcing resume`);
        isReplayingHistory = false;
      }
    }, 30_000);
  }

  const logEntry = {
    id: task.id, prompt: task.prompt, cwd: task.cwd, project: task.projectKey,
    mode: task.mode, status: "running", startedAt: new Date().toISOString(), output: [],
  };
  taskLog.push(logEntry);
  if (taskLog.length > 50) taskLog.splice(0, taskLog.length - 50);

  const isContinuation = !!task.continueTaskId;
  broadcast({
    type: "task-started", taskId: task.id, prompt: task.prompt, cwd: task.cwd,
    project: task.projectKey, mode: task.mode,
    continuing: isContinuation, clineTaskId: task.continueTaskId || null,
  });

  // Build CLI args
  let args;
  if (task.continueTaskId) {
    args = ["-T", task.continueTaskId, task.prompt];
    args.push(task.mode === "plan" ? "--plan" : "--act");
    if (task.yolo) { args.push("--yolo"); args.push("--timeout", String(task.timeout)); }
    args.push("--cwd", task.cwd);
    args.push("--json");
    if (task.model) args.push("--model", task.model);
  } else {
    args = ["task", task.prompt];
    args.push(task.mode === "plan" ? "--plan" : "--act");
    if (task.yolo) { args.push("--yolo"); args.push("--timeout", String(task.timeout)); }
    args.push("--cwd", task.cwd);
    args.push("--json");
    if (task.model) args.push("--model", task.model);
  }

  console.log(`[${task.id}] Starting: ${CLINE_PATH} ${args.join(" ")}`);

  const proc = spawn(CLINE_PATH, args, {
    cwd: task.cwd,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeProcess = proc;

  // Heartbeat
  taskStartTime = Date.now();
  lastOutputTime = Date.now();
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (!activeTask) { clearInterval(heartbeatInterval); return; }
    const elapsed = Math.round((Date.now() - taskStartTime) / 1000);
    const idle = lastOutputTime ? Math.round((Date.now() - lastOutputTime) / 1000) : elapsed;
    broadcast({
      type: "heartbeat", taskId: task.id, elapsed, idle,
      phase: lastEventType || "starting",
      model: currentModel, apiCalls: apiCallCount, cost: totalCost,
    });
  }, 3000);

  // Watchdog
  let watchdogWarned = false;
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    if (!lastOutputTime || !activeProcess) return;
    const idle = Date.now() - lastOutputTime;
    if (idle >= WATCHDOG_STALL_MS) {
      broadcast({ type: "stalled", taskId: task.id, idle: Math.round(idle / 1000) });
      clearInterval(watchdogInterval); watchdogInterval = null;
    } else if (idle >= WATCHDOG_WARN_MS && !watchdogWarned) {
      watchdogWarned = true;
      broadcast({ type: "status", text: `No output for ${Math.round(idle / 1000)}s — LLM may still be thinking` });
    }
  }, 15_000);

  // Parse Cline JSON stdout → clean client messages
  let stdoutBuf = "";

  proc.stdout.on("data", (chunk) => {
    lastOutputTime = Date.now();
    stdoutBuf += chunk.toString();

    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.substring(0, nl).trim();
      stdoutBuf = stdoutBuf.substring(nl + 1);
      if (!line) continue;

      logEntry.output.push(line);

      let parsed;
      try { parsed = JSON.parse(line); } catch {
        console.log(`[${task.id}] non-json: ${line.substring(0, 80)}`);
        continue;
      }

      processCliMessage(task.id, parsed);
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (!text) return;
    lastOutputTime = Date.now();
    logEntry.output.push(`[stderr] ${text}`);
    broadcast({ type: "error-output", taskId: task.id, text });
  });

  proc.on("close", async (code) => {
    cleanup();
    flushStreamingText(task.id);
    
    if (stdoutBuf.trim()) {
      try {
        processCliMessage(task.id, JSON.parse(stdoutBuf.trim()));
      } catch {}
    }

    const status = code === 0 ? "completed" : "failed";
    logEntry.status = status;
    logEntry.endedAt = new Date().toISOString();
    console.log(`[${task.id}] Finished: ${status} (exit ${code})`);

    // Save conversation state
    if (currentClineTaskId && task.cwd) {
      lastClineTaskIdByCwd.set(task.cwd, currentClineTaskId);
      saveConversationState();
    }

    // Auto-push changes to GitHub if enabled
    let pushResult = null;
    if (task.autoPush && task.projectKey && code === 0) {
      console.log(`[${task.id}] Auto-pushing changes for ${task.projectKey}...`);
      pushResult = await gitPushChanges(task.cwd, task.projectKey, task.prompt.substring(0, 72));
      if (pushResult.pushed) {
        broadcast({ type: "git-pushed", taskId: task.id, project: task.projectKey });
      }
    }

    broadcast({
      type: "task-done", taskId: task.id, status, exitCode: code,
      clineTaskId: currentClineTaskId || null,
      project: task.projectKey,
      gitPush: pushResult,
    });
    activeProcess = null;
    activeTask = null;

    if (taskQueue.length > 0) startTask(taskQueue.shift());
  });

  proc.on("error", (err) => {
    cleanup();
    logEntry.status = `error: ${err.message}`;
    logEntry.endedAt = new Date().toISOString();
    broadcast({ type: "task-done", taskId: task.id, status: "error", error: err.message });
    activeProcess = null;
    activeTask = null;
    if (taskQueue.length > 0) startTask(taskQueue.shift());
  });
}

function cleanup() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }
  if (streamingTimer) { clearTimeout(streamingTimer); streamingTimer = null; }
  taskStartTime = null;
}

// ---------------------------------------------------------------------------
// Process Cline CLI JSON messages
// ---------------------------------------------------------------------------
function processCliMessage(taskId, msg) {
  if (msg.type === "task_started") {
    if (msg.taskId) {
      currentClineTaskId = msg.taskId;
      if (activeTask) activeTask.clineTaskId = msg.taskId;
      console.log(`[${taskId}] Captured Cline task ID: ${msg.taskId}`);
    }
    return;
  }

  if (isReplayingHistory) {
    const askType = msg.ask || (msg.type === "ask" ? msg.ask : null);
    if (askType === "resume_task" || askType === "resume_completed_task") {
      isReplayingHistory = false;
      console.log(`[${taskId}] History replay complete, resuming conversation`);
      return;
    }
    if (msg.modelInfo && msg.modelInfo.modelId) currentModel = msg.modelInfo.modelId;
    return;
  }

  if (msg.modelInfo && msg.modelInfo.modelId) currentModel = msg.modelInfo.modelId;

  const say = msg.say || msg.type;
  lastEventType = say;

  switch (say) {
    case "task":
      if (currentModel) {
        broadcast({ type: "model", taskId, model: currentModel, provider: msg.modelInfo?.providerId });
      }
      break;

    case "api_req_started":
      apiCallCount++;
      let thinkingLabel = "Thinking...";
      try {
        const info = JSON.parse(msg.text);
        const req = info.request || "";
        if (req.includes("[ERROR]")) thinkingLabel = "Retrying after error...";
        else if (req.includes("<task>")) thinkingLabel = "Processing task...";
        else if (req.includes("[write_to_file") || req.includes("[replace_in_file")) thinkingLabel = "File saved → next step...";
        else if (req.includes("[execute_command")) thinkingLabel = "Command done → analyzing...";
        else if (req.includes("[read_file")) thinkingLabel = "File read → analyzing...";
        else if (req.includes("[search_files") || req.includes("[list_files")) thinkingLabel = "Search done → analyzing...";
        else if (req.includes("Result:")) thinkingLabel = "Processing result...";
      } catch {}
      broadcast({ type: "thinking", taskId, label: thinkingLabel, apiCall: apiCallCount, model: currentModel });
      break;

    case "api_req_finished":
      try {
        const info = JSON.parse(msg.text);
        if (info.cost != null) {
          totalCost += Number(info.cost);
          broadcast({ type: "cost", taskId, cost: Number(info.cost), total: totalCost, apiCall: apiCallCount });
        }
      } catch {}
      break;

    case "text":
      if (msg.text && msg.text.trim().length > 0) {
        if (msg.partial) {
          streamingText = msg.text;
          if (!streamingTimer) {
            streamingTimer = setTimeout(() => {
              streamingTimer = null;
              if (streamingText) {
                broadcast({ type: "text", taskId, text: streamingText, partial: true });
              }
            }, STREAM_BATCH_MS);
          }
        } else {
          flushStreamingText(taskId);
          broadcast({ type: "text", taskId, text: msg.text, partial: false });
        }
      }
      break;

    case "tool":
      flushStreamingText(taskId);
      try {
        const toolInfo = JSON.parse(msg.text);
        broadcast({
          type: "tool", taskId,
          tool: toolInfo.tool || toolInfo.name || "unknown",
          path: toolInfo.path || toolInfo.command || toolInfo.regex || "",
          content: (toolInfo.content || "").substring(0, 2000),
          diff: toolInfo.diff ? toolInfo.diff.substring(0, 2000) : undefined,
        });
      } catch {
        broadcast({ type: "tool", taskId, tool: "tool", path: "", content: msg.text?.substring(0, 500) || "" });
      }
      break;

    case "command":
      flushStreamingText(taskId);
      broadcast({ type: "command", taskId, command: msg.text || "" });
      break;

    case "command_output":
      broadcast({ type: "command-output", taskId, text: (msg.text || "").substring(0, 3000) });
      break;

    case "completion_result":
      flushStreamingText(taskId);
      broadcast({ type: "result", taskId, text: msg.text || "" });
      if (msg.ask === "completion_result") {
        broadcast({ type: "ask", taskId, askType: "completion_result", text: msg.text || "" });
      }
      break;

    case "task_progress":
      broadcast({ type: "progress", taskId, text: msg.text || "" });
      break;

    case "user_feedback":
      broadcast({ type: "user-msg", taskId, text: msg.text || "" });
      break;

    case "error":
      broadcast({ type: "error-output", taskId, text: msg.text || "Unknown error" });
      break;

    default:
      if (msg.ask || msg.type === "ask") {
        const askType = msg.ask || "followup";
        
        if (askType === "resume_task" || askType === "resume_completed_task") {
          console.log(`[${taskId}] Auto-responding to ${askType}`);
          if (activeProcess?.stdin) {
            activeProcess.stdin.write(JSON.stringify({ type: "userResponse", value: "resume" }) + "\n");
          }
          return;
        }
        
        flushStreamingText(taskId);
        broadcast({ type: "ask", taskId, askType, text: msg.text || "" });
        return;
      }
      console.log(`[${taskId}] skip: ${say}`);
  }
}

function flushStreamingText(taskId) {
  if (streamingTimer) { clearTimeout(streamingTimer); streamingTimer = null; }
  if (streamingText) {
    broadcast({ type: "text", taskId, text: streamingText, partial: true });
    streamingText = "";
  }
}

// ---------------------------------------------------------------------------
// Cancel task
// ---------------------------------------------------------------------------
function handleCancelTask(ws, msg) {
  if (activeTask && activeTask.id === msg.taskId && activeProcess) {
    activeProcess.kill("SIGTERM");
    ws.send(JSON.stringify({ type: "cancelled", taskId: msg.taskId }));
    return;
  }
  const idx = taskQueue.findIndex((t) => t.id === msg.taskId);
  if (idx !== -1) {
    taskQueue.splice(idx, 1);
    ws.send(JSON.stringify({ type: "cancelled", taskId: msg.taskId }));
    return;
  }
  ws.send(JSON.stringify({ type: "error", message: `Task not found: ${msg.taskId}` }));
}

// ---------------------------------------------------------------------------
// Task respond (write to stdin)
// ---------------------------------------------------------------------------
function handleTaskRespond(ws, msg) {
  if (!activeProcess || !activeTask) {
    ws.send(JSON.stringify({ type: "error", message: "No active task" }));
    return;
  }
  const response = msg.response || "";
  console.log(`[${activeTask.id}] User: ${response.substring(0, 100)}`);
  try {
    activeProcess.stdin.write(response + "\n");
    broadcast({ type: "user-msg", taskId: activeTask.id, text: response });
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: `Stdin error: ${err.message}` }));
  }
}

// ---------------------------------------------------------------------------
// Projects list
// ---------------------------------------------------------------------------
function handleListProjects(ws) {
  const projects = loadProjects();
  const list = Object.entries(projects).map(([key, p]) => ({
    key,
    repo: p.repo,
    liveUrl: p.liveUrl || null,
    hotLoadUrl: p.hotLoadUrl || null,
    description: p.description || "",
    hasClone: existsSync(getRepoDir(key)),
  }));
  ws.send(JSON.stringify({ type: "projects", projects: list }));
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Ensure data directories exist
try {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(REPOS_DIR, { recursive: true });
} catch {}

// Ensure git is available (nixpacks images may not have it)
try {
  execSync("git --version", { stdio: "pipe" });
  console.log("[setup] git already available");
} catch {
  console.log("[setup] git not found — installing...");
  try {
    // Try apt-get (Debian/Ubuntu-based nixpacks images)
    execSync("apt-get update && apt-get install -y git openssh-client", { stdio: "pipe", timeout: 120_000 });
    console.log("[setup] git installed via apt-get");
  } catch (e1) {
    try {
      // Try apk (Alpine-based images)
      execSync("apk add --no-cache git openssh-client", { stdio: "pipe", timeout: 60_000 });
      console.log("[setup] git installed via apk");
    } catch (e2) {
      console.error("[setup] FATAL: Could not install git. Clone/push will fail.");
      console.error("[setup] apt-get error:", e1.message);
      console.error("[setup] apk error:", e2.message);
    }
  }
}

// Configure git globally
try {
  execSync('git config --global user.email "cline@clinecloud.dev"', { stdio: "pipe" });
  execSync('git config --global user.name "ClineCloud"', { stdio: "pipe" });
} catch {}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n☁️  ClineCloud v1.0`);
  console.log(`   Port:     ${PORT}`);
  console.log(`   PIN:      ${PIN}`);
  console.log(`   Cline:    ${CLINE_PATH}`);
  console.log(`   Data:     ${DATA_DIR}`);
  console.log(`   Repos:    ${REPOS_DIR}`);
  console.log(`   GH Token: ${GH_TOKEN ? "configured" : "NOT SET"}\n`);
  
  // List registered projects
  const projects = loadProjects();
  const keys = Object.keys(projects);
  if (keys.length > 0) {
    console.log(`   Projects: ${keys.join(", ")}`);
  } else {
    console.log(`   Projects: none (register via POST /api/projects)`);
  }
  console.log();
});

setInterval(() => {
  for (const c of wss.clients) { if (c.readyState === 1) c.ping(); }
}, 30_000);

process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down...");
  cleanup();
  if (activeProcess) activeProcess.kill("SIGTERM");
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  cleanup();
  if (activeProcess) activeProcess.kill("SIGTERM");
  server.close(() => process.exit(0));
});
