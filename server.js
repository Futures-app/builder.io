import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer as createHttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { existsSync } from "fs";
import multer from "multer";
import AdmZip from "adm-zip";
import { v4 as uuidv4 } from "uuid";
import { spawn, exec } from "child_process";
import cors from "cors";
import util from "util";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const httpServer = createHttpServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: "*" }
});
const PORT = Number(process.env.PORT) || 3e3;
app.use(cors());
app.use(express.json());
const upload = multer({ dest: "/tmp/uploads/" });
const builds = /* @__PURE__ */ new Map();
async function getProjectStructure(dirPath, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const nodes = [];
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const isDirectory = entry.isDirectory();
      const node = { name: entry.name, isDirectory };
      if (isDirectory && depth < maxDepth) {
        node.children = await getProjectStructure(path.join(dirPath, entry.name), depth + 1, maxDepth);
      }
      nodes.push(node);
    }
    return nodes.sort((a, b) => {
      if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
      return a.isDirectory ? -1 : 1;
    });
  } catch (e) {
    return [];
  }
}
const logClients = /* @__PURE__ */ new Map();
io.on("connection", (socket) => {
  socket.on("join_build", (id) => {
    socket.join(`build_${id}`);
  });
});
const sendLog = (id, log) => {
  const state = builds.get(id);
  if (state) {
    state.logs.push(log);
  }
  const clients = logClients.get(id) || [];
  clients.forEach((client) => {
    client.write(`data: ${JSON.stringify({ log, status: state?.status })}

`);
  });
  io.to(`build_${id}`).emit("log", { log, status: state?.status });
};
async function checkInternet() {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 3e3);
    const response = await fetch("https://registry.npmjs.org/", { method: "HEAD", signal: controller.signal });
    clearTimeout(id);
    return response.ok;
  } catch {
    return false;
  }
}
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const id = uuidv4();
  const extractPath = path.join("/tmp", "builds", id);
  const zipPath = req.file.path;
  try {
    await fs.mkdir(extractPath, { recursive: true });
    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();
    let isEncrypted = false;
    for (const entry of zipEntries) {
      if (entry.header.flags & 1) {
        isEncrypted = true;
        break;
      }
      if (!entry.entryName.includes("node_modules/") && !entry.entryName.includes(".git/") && !entry.entryName.includes(".idea/")) {
        zip.extractEntryTo(entry, extractPath, true, true);
      }
    }
    if (isEncrypted) {
      throw new Error("\u0641\u0627\u06CC\u0644 ZIP \u0631\u0645\u0632\u06AF\u0630\u0627\u0631\u06CC \u0634\u062F\u0647 \u0627\u0633\u062A. \u0644\u0637\u0641\u0627\u064B \u0631\u0645\u0632 \u0639\u0628\u0648\u0631 \u0631\u0627 \u0628\u0631\u062F\u0627\u0631\u06CC\u062F \u0648 \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F.");
    }
    let projectRoot = extractPath;
    let packageJsonPath = path.join(projectRoot, "package.json");
    if (!existsSync(packageJsonPath)) {
      const pkgEntry = zipEntries.find((e) => e.entryName.endsWith("package.json") && !e.entryName.includes("node_modules/"));
      if (pkgEntry) {
        projectRoot = path.join(extractPath, path.dirname(pkgEntry.entryName));
        packageJsonPath = path.join(projectRoot, "package.json");
      } else {
        throw new Error("\u0641\u0627\u06CC\u0644 package.json \u062F\u0631 \u0641\u0627\u06CC\u0644 ZIP \u06CC\u0627\u0641\u062A \u0646\u0634\u062F. \u0627\u06CC\u0646 \u06CC\u06A9 \u067E\u0631\u0648\u0698\u0647 \u0645\u0639\u062A\u0628\u0631 Node.js \u0646\u06CC\u0633\u062A.");
      }
    }
    const pkgStr = await fs.readFile(packageJsonPath, "utf8");
    let pkg;
    try {
      pkg = JSON.parse(pkgStr);
    } catch (e) {
      throw new Error("\u062E\u0637\u0627 \u062F\u0631 \u062E\u0648\u0627\u0646\u062F\u0646 \u0641\u0627\u06CC\u0644 package.json (\u0627\u062D\u062A\u0645\u0627\u0644\u0627\u064B \u0641\u0627\u06CC\u0644 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A)");
    }
    const allDeps = { ...pkg.dependencies || {}, ...pkg.devDependencies || {} };
    const depsDeps = Object.keys(pkg.dependencies || {});
    const devDeps = Object.keys(pkg.devDependencies || {});
    const projectFiles = await fs.readdir(projectRoot);
    let packageManager = "npm";
    if (projectFiles.includes("yarn.lock")) packageManager = "yarn";
    else if (projectFiles.includes("pnpm-lock.yaml")) packageManager = "pnpm";
    else if (projectFiles.includes("bun.lockb")) packageManager = "bun";
    const isOnline = await checkInternet();
    let installFlags = "";
    if (!isOnline) {
      installFlags = "--prefer-offline";
    }
    let installCommand = `${packageManager} install ${installFlags}`.trim();
    if (packageManager === "yarn") installCommand = `yarn install ${installFlags}`.trim();
    else if (packageManager === "pnpm") installCommand = `pnpm install ${installFlags}`.trim();
    let buildCommand = pkg.scripts?.build ? `${packageManager} run build` : "";
    let startCommand = pkg.scripts?.start ? `${packageManager} start` : pkg.scripts?.preview ? `${packageManager} run preview` : "";
    let framework = "Vanilla / Static";
    let frameworkVersion = "N/A";
    const frameworkSignatures = [
      { name: "Next.js", key: "next" },
      { name: "Nuxt.js", key: "nuxt" },
      { name: "SvelteKit", key: "@sveltejs/kit" },
      { name: "Angular", key: "@angular/core" },
      { name: "Vue", key: "vue" },
      { name: "React", key: "react" },
      { name: "Express", key: "express" },
      { name: "NestJS", key: "@nestjs/core" }
    ];
    for (const signature of frameworkSignatures) {
      if (allDeps[signature.key]) {
        framework = signature.name;
        frameworkVersion = allDeps[signature.key];
        break;
      }
    }
    if (framework === "React") {
      if (projectFiles.some((f) => f.includes("vite.config"))) framework = "React + Vite";
      else if (projectFiles.some((f) => f.includes("craco.config"))) framework = "React (CRA + Craco)";
      else framework = "React (CRA)";
    }
    const nodeVersion = pkg.engines?.node || "Default (System)";
    const projectStructure = await getProjectStructure(projectRoot);
    const buildState = {
      id,
      status: "idle",
      logs: ["\u067E\u0631\u0648\u0698\u0647 \u0628\u0627 \u0645\u0648\u0641\u0642\u06CC\u062A \u0622\u067E\u0644\u0648\u062F \u0648 \u062A\u062D\u0644\u06CC\u0644 \u0634\u062F.", `\u0641\u0631\u06CC\u0645\u200C\u0648\u0631\u06A9 \u0634\u0646\u0627\u0633\u0627\u06CC\u06CC \u0634\u062F\u0647: ${framework} (v${frameworkVersion.replace(/[\^~>]/g, "")})`],
      framework,
      frameworkVersion: frameworkVersion.replace(/[\^~>]/g, ""),
      nodeVersion,
      packageManager,
      installCommand,
      buildCommand,
      startCommand,
      dependencies: depsDeps,
      devDependencies: devDeps,
      projectStructure,
      name: pkg.name || "\u067E\u0631\u0648\u0698\u0647 \u0628\u062F\u0648\u0646 \u0646\u0627\u0645",
      projectRoot,
      isOffline: !isOnline,
      errors: [],
      warnings: [],
      diagnostics: []
    };
    if (!isOnline) {
      buildState.warnings.push({
        id: Math.random().toString(36).substr(2, 9),
        type: "warning",
        category: "network",
        message: "\u0639\u062F\u0645 \u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646\u062A\u0631\u0646\u062A \u0634\u0646\u0627\u0633\u0627\u06CC\u06CC \u0634\u062F.",
        suggestion: "\u0633\u06CC\u0633\u062A\u0645 \u0633\u0639\u06CC \u062E\u0648\u0627\u0647\u062F \u06A9\u0631\u062F \u0627\u0632 \u067E\u06A9\u06CC\u062C\u200C\u0647\u0627\u06CC \u06A9\u0634\u200C\u0634\u062F\u0647 (Offline Mode) \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0646\u062F. \u062F\u0631 \u0635\u0648\u0631\u062A \u0639\u062F\u0645 \u0648\u062C\u0648\u062F \u067E\u06A9\u06CC\u062C \u062F\u0631 \u06A9\u0634\u060C \u0628\u06CC\u0644\u062F \u0634\u06A9\u0633\u062A \u062E\u0648\u0627\u0647\u062F \u062E\u0648\u0631\u062F."
      });
    }
    if (!pkg.scripts?.build) {
      buildState.warnings.push({
        id: Math.random().toString(36).substr(2, 9),
        type: "warning",
        category: "config",
        message: "\u0627\u0633\u06A9\u0631\u06CC\u067E\u062A build \u062F\u0631 package.json \u06CC\u0627\u0641\u062A \u0646\u0634\u062F.",
        suggestion: "\u0627\u06AF\u0631 \u0627\u06CC\u0646 \u06CC\u06A9 \u067E\u0631\u0648\u0698\u0647 \u0627\u0633\u062A\u0627\u062A\u06CC\u06A9 \u0627\u0633\u062A\u060C \u0646\u06CC\u0627\u0632\u06CC \u0628\u0647 \u0628\u06CC\u0644\u062F \u0646\u06CC\u0633\u062A. \u062F\u0631 \u063A\u06CC\u0631 \u0627\u06CC\u0646 \u0635\u0648\u0631\u062A\u060C \u062A\u0646\u0638\u06CC\u0645\u0627\u062A \u0641\u0627\u06CC\u0644 package.json \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F."
      });
    }
    if (packageManager === "npm" && projectFiles.includes("yarn.lock")) {
      buildState.warnings.push({
        id: Math.random().toString(36).substr(2, 9),
        type: "warning",
        category: "dependency",
        message: "\u0641\u0627\u06CC\u0644 yarn.lock \u0648\u062C\u0648\u062F \u062F\u0627\u0631\u062F \u0627\u0645\u0627 \u0645\u062D\u06CC\u0637 \u0627\u0632 npm \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u06A9\u0631\u062F\u0647 \u0627\u0633\u062A.",
        suggestion: "\u062A\u0648\u0635\u06CC\u0647 \u0645\u06CC\u200C\u0634\u0648\u062F \u067E\u0631\u0648\u0698\u0647 \u0631\u0627 \u0628\u0627 \u0627\u0628\u0632\u0627\u0631 \u0627\u0635\u0644\u06CC \u0633\u0627\u0632\u0646\u062F\u0647\u200C\u0627\u0634 \u0627\u062C\u0631\u0627 \u06A9\u0646\u06CC\u062F \u062A\u0627 \u0627\u0632 \u062A\u062F\u0627\u062E\u0644 \u0646\u0633\u062E\u0647\u200C\u0647\u0627 \u062C\u0644\u0648\u06AF\u06CC\u0631\u06CC \u0634\u0648\u062F."
      });
    }
    if (projectFiles.includes(".env.example") && !projectFiles.includes(".env")) {
      buildState.diagnostics.push({
        id: Math.random().toString(36).substr(2, 9),
        type: "info",
        category: "config",
        message: "\u0641\u0627\u06CC\u0644 .env.example \u06CC\u0627\u0641\u062A \u0634\u062F \u0627\u0645\u0627 .env \u062F\u0631 \u067E\u0631\u0648\u0698\u0647 \u0648\u062C\u0648\u062F \u0646\u062F\u0627\u0631\u062F.",
        suggestion: "\u0627\u062D\u062A\u0645\u0627\u0644\u0627\u064B \u067E\u0631\u0648\u0698\u0647 \u0628\u0631\u0627\u06CC \u0627\u062C\u0631\u0627\u06CC \u0645\u0648\u0641\u0642\u06CC\u062A\u200C\u0622\u0645\u06CC\u0632 \u0646\u06CC\u0627\u0632 \u0628\u0647 \u0645\u062A\u063A\u06CC\u0631\u0647\u0627\u06CC \u0645\u062D\u06CC\u0637\u06CC \u062F\u0627\u0631\u062F."
      });
    }
    builds.set(id, buildState);
    await fs.unlink(zipPath);
    res.json(buildState);
  } catch (error) {
    console.error("Upload Error:", error);
    res.status(500).json({ error: error.message });
  }
});
app.get("/api/builds", (req, res) => {
  res.json(Array.from(builds.values()));
});
app.post("/api/build-addons/:id/:type", async (req, res) => {
  const { id, type } = req.params;
  const state = builds.get(id);
  if (!state) return res.status(404).json({ error: "Build not found" });
  const projectPath = state.projectRoot || path.join("/tmp", "builds", id);
  if (!existsSync(projectPath)) return res.status(404).json({ error: "Project files missing" });
  try {
    if (type === "docker") {
      const isSSR = state.framework.toLowerCase().includes("next") || state.framework.toLowerCase().includes("nuxt") || state.framework.toLowerCase().includes("express");
      let dockerfile = "";
      if (!isSSR) {
        dockerfile = `FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`;
      } else {
        const pm = state.packageManager || "npm";
        const lockFileMap = { "npm": "package-lock.json*", "yarn": "yarn.lock", "pnpm": "pnpm-lock.yaml*" };
        dockerfile = `FROM node:18-alpine
WORKDIR /app
COPY package.json ${lockFileMap[pm] || "*"} ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE \${PORT:-3000}
CMD ["npm", "start"]`;
      }
      await fs.writeFile(path.join(projectPath, "Dockerfile"), dockerfile, "utf8");
      await fs.writeFile(path.join(projectPath, ".dockerignore"), "node_modules\\n.git\\n.env\\ndist\\nbuild", "utf8");
      if (!isSSR) {
        const nginxConf = `server {
  listen 80;
  location / {
    root /usr/share/nginx/html;
    index index.html index.htm;
    try_files $uri $uri/ /index.html;
  }
}`;
        await fs.writeFile(path.join(projectPath, "nginx.conf"), nginxConf, "utf8");
      }
      return res.json({ message: "\u0641\u0627\u06CC\u0644\u200C\u0647\u0627\u06CC Docker \u0628\u0627 \u0645\u0648\u0641\u0642\u06CC\u062A \u062A\u0648\u0644\u06CC\u062F \u0634\u062F\u0646\u062F." });
    }
    if (type === "webserver") {
      const isSPA = state.framework.toLowerCase().includes("react") || state.framework.toLowerCase().includes("vue") || state.framework.toLowerCase().includes("svelte") || state.framework.toLowerCase().includes("vanilla");
      if (isSPA) {
        const htaccess = `<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>`;
        const nginxConf = `server {
  listen 80;
  location / {
    try_files $uri $uri/ /index.html;
  }
}`;
        let targetDir = path.join(projectPath, "dist");
        if (!existsSync(targetDir)) {
          targetDir = path.join(projectPath, "build");
          if (!existsSync(targetDir)) targetDir = projectPath;
        }
        await fs.writeFile(path.join(targetDir, ".htaccess"), htaccess, "utf8");
        await fs.writeFile(path.join(projectPath, "nginx.conf"), nginxConf, "utf8");
        return res.json({ message: "\u0641\u0627\u06CC\u0644\u200C\u0647\u0627\u06CC \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0648\u0628\u200C\u0633\u0631\u0648\u0631 \u062A\u0648\u0644\u06CC\u062F \u0648 \u062C\u0627\u06CC\u200C\u06AF\u0630\u0627\u0631\u06CC \u0634\u062F\u0646\u062F." });
      } else {
        return res.status(400).json({ error: "\u0627\u06CC\u0646 \u067E\u0631\u0648\u0698\u0647 SPA (\u0633\u0645\u062A \u06A9\u0644\u0627\u06CC\u0646\u062A) \u0646\u06CC\u0633\u062A \u0648 \u0646\u06CC\u0627\u0632 \u0628\u0647 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0648\u0628\u200C\u0633\u0631\u0648\u0631 \u0646\u062F\u0627\u0631\u062F." });
      }
    }
    return res.status(400).json({ error: "\u0646\u0648\u0639 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
app.get("/api/builds/:id", (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) return res.status(404).json({ error: "Not found" });
  res.json(build);
});
app.post("/api/build/:id", async (req, res) => {
  const id = req.params.id;
  const state = builds.get(id);
  const repairMode = req.query.repair === "true";
  const isTest = req.query.test === "true";
  if (!state) {
    return res.status(404).json({ error: "Build not found" });
  }
  if (state.status === "installing" || state.status === "building") {
    return res.status(400).json({ error: "Build already in progress" });
  }
  if (repairMode) {
    state.errors = [];
    state.warnings = [];
    state.logs.push(`
> \u062D\u0627\u0644\u062A \u062A\u0639\u0645\u06CC\u0631 \u062E\u0648\u062F\u06A9\u0627\u0631 (Smart Repair) \u0641\u0639\u0627\u0644 \u0634\u062F...
`);
  }
  const projectPath = state.projectRoot || path.join("/tmp", "builds", id);
  res.json({ message: "Build started" });
  if (repairMode) {
    try {
      await fs.rm(path.join(projectPath, "node_modules"), { recursive: true, force: true });
      await fs.rm(path.join(projectPath, "package-lock.json"), { force: true });
      await fs.rm(path.join(projectPath, "yarn.lock"), { force: true });
      await fs.rm(path.join(projectPath, "pnpm-lock.yaml"), { force: true });
    } catch (e) {
    }
  }
  const runCommand = (cmd, args, stepStatus) => {
    return new Promise((resolve, reject) => {
      state.status = stepStatus;
      sendLog(id, `
> Running: ${cmd} ${args.join(" ")}
`);
      const p = spawn(cmd, args, { cwd: projectPath, shell: true, env: { ...process.env, FORCE_COLOR: "1" } });
      const processOutput = (data, isError) => {
        const str = data.toString();
        sendLog(id, str);
        const lowerStr = str.toLowerCase();
        if (lowerStr.includes("error") || lowerStr.includes("err!")) {
          let cat = "syntax";
          if (lowerStr.includes("eeresolve") || lowerStr.includes("peer") || lowerStr.includes("dependency")) {
            cat = "dependency";
          } else if (lowerStr.includes("enotfound") || lowerStr.includes("eai_again") || lowerStr.includes("network") || lowerStr.includes("offline")) {
            cat = "network";
          }
          const diags = {
            id: Math.random().toString(36).substr(2, 9),
            type: "error",
            category: cat,
            message: str.split("\n").find((l) => l.toLowerCase().includes("error") || l.toLowerCase().includes("err!")) || "\u062E\u0637\u0627\u06CC \u0646\u0627\u0634\u0646\u0627\u062E\u062A\u0647"
          };
          if (str.includes("Cannot find module")) {
            diags.message = "\u067E\u06A9\u06CC\u062C\u06CC \u06CC\u0627\u0641\u062A \u0646\u0634\u062F \u06CC\u0627 \u0646\u0635\u0628 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A.";
            diags.suggestion = "\u0645\u0645\u06A9\u0646 \u0627\u0633\u062A \u0646\u06CC\u0627\u0632 \u0628\u0647 \u0646\u0635\u0628 \u067E\u06A9\u06CC\u062C\u200C\u0647\u0627\u06CC \u0627\u0636\u0627\u0641\u06CC \u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u06CC\u062F.";
            diags.category = "dependency";
          }
          if (cat === "network") {
            diags.message = "\u062E\u0637\u0627\u06CC \u0627\u062A\u0635\u0627\u0644 \u0628\u0647 \u0627\u06CC\u0646\u062A\u0631\u0646\u062A \u062D\u06CC\u0646 \u062F\u0627\u0646\u0644\u0648\u062F \u0648\u0627\u0628\u0633\u062A\u06AF\u06CC (\u067E\u06A9\u06CC\u062C). \u0634\u0628\u06A9\u0647 \u0645\u0633\u062F\u0648\u062F \u0634\u062F\u0647 \u0627\u0633\u062A \u06CC\u0627 \u067E\u06A9\u06CC\u062C \u062F\u0631 \u06A9\u0634 \u0633\u06CC\u0633\u062A\u0645 \u0622\u0641\u0644\u0627\u06CC\u0646 \u0645\u0648\u062C\u0648\u062F \u0646\u06CC\u0633\u062A.";
            diags.suggestion = "\u062F\u0633\u062A\u0631\u0633\u06CC \u0628\u0647 \u0627\u06CC\u0646\u062A\u0631\u0646\u062A \u06A9\u0627\u0645\u0644\u0627\u064B \u0627\u0644\u0632\u0627\u0645\u06CC \u0627\u0633\u062A. \u0627\u06CC\u0646 \u067E\u06A9\u06CC\u062C \u0627\u0632 \u0642\u0628\u0644 \u062F\u0631 \u0633\u06CC\u0633\u062A\u0645 \u06A9\u0634 \u0646\u0634\u062F\u0647 \u0627\u0633\u062A. \u0644\u0637\u0641\u0627\u064B \u0627\u0631\u062A\u0628\u0627\u0637 \u0633\u0631\u0648\u0631 \u0631\u0627 \u0628\u0631\u0631\u0633\u06CC \u06A9\u0646\u06CC\u062F.";
          }
          if (!state.errors.some((e) => e.message === diags.message)) {
            state.errors.push(diags);
          }
        } else if (lowerStr.includes("warning") || lowerStr.includes("warn")) {
          const warnMsg = str.split("\n").find((l) => l.toLowerCase().includes("warn")) || "\u0647\u0634\u062F\u0627\u0631";
          if (!state.warnings.some((w) => w.message === warnMsg)) {
            state.warnings.push({
              id: Math.random().toString(36).substr(2, 9),
              type: "warning",
              category: "general",
              message: warnMsg
            });
          }
        }
      };
      p.stdout.on("data", (data) => processOutput(data, false));
      p.stderr.on("data", (data) => processOutput(data, true));
      p.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command ${cmd} exited with code ${code}`));
        }
      });
      p.on("error", (err) => {
        state.errors.push({
          id: Math.random().toString(36).substr(2, 9),
          type: "error",
          category: "general",
          message: err.message
        });
        sendLog(id, `Error: ${err.message}`);
        reject(err);
      });
    });
  };
  try {
    const pkgPath = path.join(projectPath, "package.json");
    if (!existsSync(pkgPath)) {
      throw new Error("\u0641\u0627\u06CC\u0644 package.json \u06CC\u0627\u0641\u062A \u0646\u0634\u062F! \u067E\u0631\u0648\u0698\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u0627\u0633\u062A.");
    }
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    let pm = state.packageManager || "npm";
    try {
      const installFlags = [];
      if (state.isOffline) {
        installFlags.push("--prefer-offline");
      }
      if (repairMode) {
        installFlags.push("--force");
      }
      if (pm === "yarn") {
        await runCommand("npx", ["-y", "yarn", "install", ...installFlags], "installing");
      } else if (pm === "pnpm") {
        await runCommand("npx", ["-y", "pnpm", "install", "--no-frozen-lockfile", ...installFlags], "installing");
      } else if (pm === "bun") {
        await runCommand("npx", ["-y", "bun", "install"], "installing");
      } else {
        await runCommand("npm", ["install", "--no-fund", "--no-audit", ...installFlags], "installing");
      }
    } catch (installErr) {
      sendLog(id, `
\u26A0\uFE0F Installation failed. Attempting safe fallback with npm install --legacy-peer-deps...
`);
      await runCommand("npm", ["install", "--no-fund", "--no-audit", "--legacy-peer-deps"], "installing");
    }
    if (pkg.scripts && pkg.scripts.build) {
      if (pm === "yarn") {
        await runCommand("npx", ["-y", "yarn", "build"], "building");
      } else if (pm === "pnpm") {
        await runCommand("npx", ["-y", "pnpm", "run", "build"], "building");
      } else if (pm === "bun") {
        await runCommand("npx", ["-y", "bun", "run", "build"], "building");
      } else {
        await runCommand("npm", ["run", "build"], "building");
      }
      let distPath = path.join(projectPath, "dist");
      let buildPath = path.join(projectPath, "build");
      let outPath = path.join(projectPath, "out");
      let nextPath = path.join(projectPath, ".next");
      if (!existsSync(distPath) && !existsSync(buildPath) && !existsSync(outPath) && !existsSync(nextPath)) {
        sendLog(id, `
\u26A0\uFE0F \u0647\u0634\u062F\u0627\u0631: \u067E\u0648\u0634\u0647 \u062E\u0631\u0648\u062C\u06CC (dist, build, out \u06CC\u0627 .next) \u06CC\u0627\u0641\u062A \u0646\u0634\u062F. \u0645\u0645\u06A9\u0646 \u0627\u0633\u062A \u0628\u06CC\u0644\u062F \u0628\u0647 \u062F\u0631\u0633\u062A\u06CC \u0627\u0646\u062C\u0627\u0645 \u0646\u0634\u062F\u0647 \u0628\u0627\u0634\u062F.`);
      }
    } else {
      sendLog(id, " \u0627\u0633\u06A9\u0631\u06CC\u067E\u062A build \u06CC\u0627\u0641\u062A \u0646\u0634\u062F. \u0641\u0631\u0636 \u0645\u06CC\u200C\u06A9\u0646\u06CC\u0645 \u067E\u0631\u0648\u0698\u0647 \u0627\u0633\u062A\u0627\u062A\u06CC\u06A9 \u06CC\u0627 \u0627\u0632 \u0642\u0628\u0644 \u0628\u06CC\u0644\u062F \u0634\u062F\u0647 \u0627\u0633\u062A.");
    }
    state.status = "success";
    sendLog(id, "\n\u2705 \u0628\u06CC\u0644\u062F \u067E\u0631\u0648\u0698\u0647 \u0628\u0627 \u0645\u0648\u0641\u0642\u06CC\u062A \u0628\u0647 \u067E\u0627\u06CC\u0627\u0646 \u0631\u0633\u06CC\u062F!");
  } catch (err) {
    state.status = "failed";
    state.error = err.message;
    sendLog(id, `
\u274C \u062E\u0637\u0627 \u062F\u0631 \u0641\u0631\u0622\u06CC\u0646\u062F \u0628\u06CC\u0644\u062F: ${err.message}`);
  }
});
app.get("/api/logs/:id", (req, res) => {
  const id = req.params.id;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const state = builds.get(id);
  if (state) {
    state.logs.forEach((log) => {
      res.write(`data: ${JSON.stringify({ log, status: state.status })}

`);
    });
  }
  let clients = logClients.get(id);
  if (!clients) {
    clients = [];
    logClients.set(id, clients);
  }
  clients.push(res);
  req.on("close", () => {
    const clients2 = logClients.get(id);
    if (clients2) {
      const idx = clients2.indexOf(res);
      if (idx !== -1) clients2.splice(idx, 1);
    }
  });
});
app.post("/api/update-dependencies", async (req, res) => {
  try {
    const execPromise = util.promisify(exec);
    exec("npm update && npm run build", { cwd: process.cwd() }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Update Error: ${error}`);
        return;
      }
      console.log(`Update Output: ${stdout}`);
    });
    res.json({ message: "Update started" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/export-self", async (req, res) => {
  try {
    const execPromise = util.promisify(exec);
    await execPromise("npm run build", { cwd: process.cwd() });
    const { ZipArchive } = await import("archiver");
    const archive = new ZipArchive({ zlib: { level: 9 } });
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="nexus-builder-production.zip"`
    });
    archive.pipe(res);
    const rootPath = process.cwd();
    if (existsSync(path.join(rootPath, "dist"))) {
      archive.directory(path.join(rootPath, "dist"), "dist");
    }
    if (existsSync(path.join(rootPath, "node_modules"))) {
      archive.directory(path.join(rootPath, "node_modules"), "node_modules");
    }
    const essentialFiles = [
      "package.json",
      "server.ts",
      "firebase-applet-config.json",
      "tsconfig.json",
      "vite.config.ts",
      "postcss.config.js",
      "tailwind.config.js",
      ".env.example"
    ];
    for (const file of essentialFiles) {
      if (existsSync(path.join(rootPath, file))) {
        archive.file(path.join(rootPath, file), { name: file });
      }
    }
    archive.append(`\u0631\u0627\u0647\u0646\u0645\u0627\u06CC \u0646\u0635\u0628 \u0646\u06A9\u0633\u0648\u0633 \u0628\u06CC\u0644\u062F \u0631\u0648\u06CC \u0647\u0627\u0633\u062A \u0627\u0634\u062A\u0631\u0627\u06A9\u06CC \u0633\u06CC\u200C\u067E\u0646\u0644 (cPanel)

\u06A9\u0627\u0631\u0628\u0631 \u06AF\u0631\u0627\u0645\u06CC\u060C \u0633\u0644\u0627\u0645!
\u0627\u0632 \u0622\u0646\u062C\u0627\u06CC\u06CC \u06A9\u0647 \u0633\u06CC\u0633\u062A\u0645 \u0646\u06A9\u0633\u0648\u0633 \u0628\u06CC\u0644\u062F \u06CC\u06A9 \u067E\u0631\u0648\u0698\u0647 \u0628\u06A9\u200C\u0627\u0646\u062F \u0628\u0627 Node.js (\u0648 Express) \u0627\u0633\u062A\u060C \u0634\u0645\u0627 \u0646\u0645\u06CC\u200C\u062A\u0648\u0627\u0646\u06CC\u062F \u0641\u0642\u0637 \u0641\u0627\u06CC\u0644\u200C\u0647\u0627 \u0631\u0627 \u062F\u0631 \u067E\u0648\u0634\u0647 public_html \u06A9\u067E\u06CC \u06A9\u0646\u06CC\u062F \u062A\u0627 \u06A9\u0627\u0631 \u06A9\u0646\u062F.
\u0628\u0631\u0627\u06CC \u0631\u0627\u0647\u200C\u0627\u0646\u062F\u0627\u0632\u06CC\u060C \u0634\u0645\u0627 \u0628\u0647 \u0642\u0627\u0628\u0644\u06CC\u062A "Setup Node.js App" \u062F\u0631 \u0633\u06CC\u200C\u067E\u0646\u0644 \u0646\u06CC\u0627\u0632 \u062F\u0627\u0631\u06CC\u062F:

\u0645\u0631\u0627\u062D\u0644 \u0627\u062C\u0631\u0627 \u062F\u0631 \u0647\u0627\u0633\u062A \u0627\u0634\u062A\u0631\u0627\u06A9\u06CC:
1. \u0627\u0628\u062A\u062F\u0627 \u0627\u0632 \u062F\u0627\u062E\u0644 \u0633\u06CC\u200C\u067E\u0646\u0644 \u0631\u0648\u06CC \u06AF\u0632\u06CC\u0646\u0647 "Setup Node.js App" \u06A9\u0644\u06CC\u06A9 \u06A9\u0646\u06CC\u062F.
2. \u06CC\u06A9 \u0627\u067E\u0644\u06CC\u06A9\u06CC\u0634\u0646 \u062C\u062F\u06CC\u062F \u0628\u0633\u0627\u0632\u06CC\u062F.
   - \u0646\u0633\u062E\u0647 Node.js \u0631\u0627 \u062A\u0631\u062C\u06CC\u062D\u0627 \u0631\u0648\u06CC \u0628\u0627\u0644\u0627\u062A\u0631\u06CC\u0646 \u0646\u0633\u062E\u0647 \u062A\u0646\u0638\u06CC\u0645 \u06A9\u0646\u06CC\u062F.
   - Application mode \u0631\u0627 \u0631\u0648\u06CC Production \u062A\u0646\u0638\u06CC\u0645 \u06A9\u0646\u06CC\u062F.
   - Application root: \u06CC\u06A9 \u067E\u0648\u0634\u0647 \u062E\u0627\u0631\u062C \u0627\u0632 public_html \u062A\u0639\u0631\u06CC\u0641 \u06A9\u0646\u06CC\u062F (\u0645\u062B\u0644\u0627 nexus-app).
   - Application URL: \u0622\u062F\u0631\u0633\u06CC \u06A9\u0647 \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u06CC\u062F \u0628\u0627 \u0622\u0646 \u067E\u0646\u0644 \u0628\u0627\u0632 \u0634\u0648\u062F \u0631\u0627 \u0645\u0634\u062E\u0635 \u06A9\u0646\u06CC\u062F. (\u0645\u062B\u0644\u0627 site.com/nexus)
   - Application startup file: \u0628\u0646\u0648\u06CC\u0633\u06CC\u062F: dist/server.js
3. \u0631\u0648\u06CC \u062F\u06A9\u0645\u0647 Create \u06A9\u0644\u06CC\u06A9 \u06A9\u0646\u06CC\u062F \u062A\u0627 \u0627\u067E\u0644\u06CC\u06A9\u06CC\u0634\u0646 \u0633\u0627\u062E\u062A\u0647 \u0634\u0648\u062F.
4. \u0641\u0627\u06CC\u0644 \u0632\u06CC\u067E \u0627\u06A9\u0633\u062A\u0631\u06A9\u062A \u0634\u062F\u0647 (\u0647\u0645\u06CC\u0634\u0647 \u0641\u0627\u06CC\u0644\u200C\u0647\u0627) \u0631\u0627 \u062F\u0627\u062E\u0644 \u067E\u0648\u0634\u0647 nexus-app (Application root) \u0622\u067E\u0644\u0648\u062F \u0648 \u0627\u0633\u062A\u062E\u0631\u0627\u062C \u06A9\u0646\u06CC\u062F.
5. \u0628\u0647 \u067E\u0646\u0644 Setup Node.js App \u0628\u0631\u06AF\u0631\u062F\u06CC\u062F \u0648 \u0631\u0648\u06CC \u062F\u06A9\u0645\u0647 "NPM Install" \u06CC\u0627 "Run NPM Install" \u06A9\u0644\u06CC\u06A9 \u06A9\u0646\u06CC\u062F \u062A\u0627 \u062A\u0645\u0627\u0645 \u067E\u06A9\u06CC\u062C\u200C\u0647\u0627\u06CC \u0644\u0627\u0632\u0645 \u0646\u0635\u0628 \u0634\u0648\u0646\u062F.
6. \u062F\u0631 \u0646\u0647\u0627\u06CC\u062A \u067E\u0633 \u0627\u0632 \u0627\u062A\u0645\u0627\u0645 \u0646\u0635\u0628\u060C \u0631\u0648\u06CC Restart Application \u06A9\u0644\u06CC\u06A9 \u06A9\u0646\u06CC\u062F.

\u0646\u06A9\u062A\u0647 \u0645\u0647\u0645: 
\u0628\u0627 \u062A\u0648\u062C\u0647 \u0628\u0647 \u0627\u06CC\u0646\u06A9\u0647 \u0647\u0627\u0633\u062A\u200C\u0647\u0627\u06CC \u0627\u0634\u062A\u0631\u0627\u06A9\u06CC \u0627\u063A\u0644\u0628 \u0627\u062C\u0627\u0632\u0647 \u0627\u062C\u0631\u0627\u06CC \u062F\u0633\u062A\u0648\u0631\u0627\u062A \u0633\u0646\u06AF\u06CC\u0646 npm run build \u0631\u0627 \u0628\u0647 \u0628\u0631\u0646\u0627\u0645\u0647\u200C\u0647\u0627\u06CC \u062F\u0631 \u062D\u0627\u0644 \u0627\u062C\u0631\u0627 \u0627\u0632 \u0637\u0631\u06CC\u0642 child_process \u0646\u0645\u06CC\u200C\u062F\u0647\u0646\u062F\u060C \u0642\u0627\u0628\u0644\u06CC\u062A \u0628\u06CC\u0644\u062F \u0628\u0631\u0646\u0627\u0645\u0647\u200C\u0647\u0627 \u062F\u0631 \u062F\u0627\u062E\u0644 \u0646\u06A9\u0633\u0648\u0633 \u0645\u0645\u06A9\u0646 \u0627\u0633\u062A \u062F\u0631 \u0647\u0627\u0633\u062A \u0627\u0634\u062A\u0631\u0627\u06A9\u06CC \u062F\u0686\u0627\u0631 \u062E\u0637\u0627 \u0634\u0648\u062F.
\u0646\u06A9\u0633\u0648\u0633 \u0628\u06CC\u0644\u062F \u0628\u0631\u0627\u06CC \u0631\u0627\u0646\u062F\u0645\u0627\u0646 \u06A9\u0627\u0645\u0644 \u0628\u0647\u062A\u0631 \u0627\u0633\u062A \u0631\u0648\u06CC \u06CC\u06A9 VPS \u06CC\u0627 \u06A9\u0627\u0646\u062A\u06CC\u0646\u0631 \u0627\u0628\u0631\u06CC \u0645\u06CC\u0632\u0628\u0627\u0646\u06CC \u0634\u0648\u062F.
`, { name: "cPanel-Instructions-fa.txt" });
    await archive.finalize();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).send({ error: e.message });
    }
  }
});
app.get("/api/download/:id", async (req, res) => {
  const id = req.params.id;
  const state = builds.get(id);
  const projectPath = state?.projectRoot || path.join("/tmp", "builds", id);
  if (!existsSync(projectPath)) {
    return res.status(404).send("Project not found");
  }
  try {
    const archiverName = "archiver";
    const archiverModule = await import(archiverName);
    const archiver = archiverModule.default || archiverModule;
    const archive = archiver("zip", {
      zlib: { level: 9 }
      // Sets the compression level.
    });
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="project-${id}.zip"`
    });
    archive.on("warning", function(err) {
      if (err.code === "ENOENT") {
        console.warn(err);
      } else {
        throw err;
      }
    });
    archive.on("error", function(err) {
      throw err;
    });
    archive.pipe(res);
    archive.glob("**/*", {
      cwd: projectPath,
      ignore: ["node_modules/**", ".git/**"]
    });
    await archive.finalize();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).send(e.message);
    }
  }
});
app.use("/preview/:id", (req, res, next) => {
  const id = req.params.id;
  const state = builds.get(id);
  if (!state || state.status !== "success") {
    return res.status(404).send("Preview not found or build not successful.");
  }
  const projectPath = state.projectRoot || path.join("/tmp", "builds", id);
  if (!existsSync(projectPath)) {
    return res.status(404).send("Preview not found");
  }
  let distPath = path.join(projectPath, "dist");
  if (!existsSync(distPath)) {
    distPath = path.join(projectPath, "build");
  }
  if (!existsSync(distPath)) {
    distPath = path.join(projectPath, "out");
  }
  if (!existsSync(distPath)) {
    distPath = path.join(projectPath, ".next");
  }
  if (!existsSync(distPath)) {
    distPath = projectPath;
  }
  express.static(distPath)(req, res, next);
});
app.get("/preview/:id/*", (req, res) => {
  const id = req.params.id;
  const state = builds.get(id);
  if (!state || state.status !== "success") {
    return res.status(404).send("Preview not found or build not successful.");
  }
  const projectPath = state.projectRoot || path.join("/tmp", "builds", id);
  let distPath = path.join(projectPath, "dist");
  if (!existsSync(distPath)) distPath = path.join(projectPath, "build");
  if (!existsSync(distPath)) distPath = path.join(projectPath, "out");
  if (!existsSync(distPath)) distPath = path.join(projectPath, ".next");
  if (!existsSync(distPath)) distPath = projectPath;
  res.sendFile(path.join(distPath, "index.html"));
});
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "..", "dist");
    app.use(express.static(__dirname));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "index.html"));
    });
  }
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}
startServer();
export {
  io
};
