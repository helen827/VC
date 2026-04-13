const $ = (sel) => document.querySelector(sel);

const pastesEl = $("#pastes");
const addPasteBtn = $("#addPasteBtn");
const pastedBlocksJsonEl = $("#pastedBlocksJson");
const statusEl = $("#status");
const downloadEl = $("#download");
const sopBoxEl = $("#sopBox");
const zipLinkEl = $("#zipLink");
const filesHintEl = $("#filesHint");
const navEl = $("#nav");
const docKickerEl = $("#docKicker");
const docTitleEl = $("#docTitle");
const docMetaEl = $("#docMeta");
const docBodyEl = $("#docBody");
const copyBtnEl = $("#copyBtn");
const formEl = $("#form");
const resetBtn = $("#resetBtn");

const uploadInputEl = $("#uploadFiles");
const uploadFileListEl = $("#uploadFileList");
const uploadHintEl = $("#uploadHint");
const clearUploadBtn = $("#clearUploadBtn");
const MAX_UPLOAD_FILES = 10;
/** @type {File[]} */
let uploadFileBucket = [];

// Wizard (GEO onboarding)
const stepperEl = $("#stepper");
const wizardStepEl = $("#wizardStep");
const wizardMetaEl = $("#wizardMeta");
const prevStepBtn = $("#prevStepBtn");
const nextStepBtn = $("#nextStepBtn");
const wizardSummaryEl = $("#wizardSummary");
const wizardSteps = Array.from(document.querySelectorAll(".wizardStep"));
const TOTAL_STEPS = 5;

const companyAliasesEl = $("#companyAliases");
const companyOneLinerEl = $("#companyOneLiner");
const desiredPerceptionEl = $("#desiredPerception");
const audienceMarketEl = $("#audienceMarket");
const audienceGovFundEl = $("#audienceGovFund");
const competitorsEl = $("#competitors");
const userQuestionsEl = $("#userQuestions");
const mustBeTrueEl = $("#mustBeTrue");
const claimsToAvoidEl = $("#claimsToAvoid");
const industryEl = $("#industry");
const productEl = $("#product");
const productDefinitionEl = $("#productDefinition");
const genQuestionsBtn = $("#genQuestionsBtn");
const plainTextEvidenceEl = $("#plainTextEvidence");

// Access gate (public deployment)
const gateOverlayEl = $("#gateOverlay");
const gatePasswordEl = $("#gatePassword");
const gateSubmitEl = $("#gateSubmit");
const gateErrorEl = $("#gateError");

const ACCESS_TOKEN_STORAGE_KEY = "geo_agent_access_token";
function getAccessToken() {
  try {
    return localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}
function setAccessToken(token) {
  try {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, String(token || ""));
  } catch {}
}
function showGate(errorText) {
  if (!gateOverlayEl) return;
  gateOverlayEl.style.display = "flex";
  if (gateErrorEl) {
    gateErrorEl.style.display = errorText ? "block" : "none";
    if (errorText) gateErrorEl.textContent = errorText;
  }
  setTimeout(() => {
    try {
      gatePasswordEl?.focus();
    } catch {}
  }, 0);
}
function hideGate() {
  if (!gateOverlayEl) return;
  gateOverlayEl.style.display = "none";
  if (gateErrorEl) gateErrorEl.style.display = "none";
}

async function authFetch(url, init) {
  const token = getAccessToken();
  const headers = new Headers(init && init.headers ? init.headers : undefined);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...(init || {}), headers });
  if (res.status === 401) {
    showGate("密码不正确或已过期，请重新输入。");
  }
  return res;
}

if (gateSubmitEl) {
  gateSubmitEl.addEventListener("click", async () => {
    const token = String(gatePasswordEl?.value || "").trim();
    setAccessToken(token);
    const ok = await authFetch("/healthz");
    if (ok.ok) {
      hideGate();
      return;
    }
    // reset on failure
    setAccessToken("");
    showGate("密码不正确，请重试。");
  });
}
if (gatePasswordEl) {
  gatePasswordEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      gateSubmitEl?.click();
    }
  });
}

function setStatus(text) {
  statusEl.textContent = text || "";
}

function setDownload(html) {
  downloadEl.innerHTML = html || "";
}

function setSopVisible(visible) {
  sopBoxEl.style.display = visible ? "block" : "none";
}

function clearSop() {
  navEl.innerHTML = "";
  docKickerEl.textContent = "";
  docTitleEl.textContent = "—";
  docMetaEl.textContent = "";
  docBodyEl.innerHTML = "";
  copyBtnEl.style.display = "none";
  copyBtnEl.disabled = true;
}

async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}

function mdToPlainText(md) {
  const s = String(md || "");
  const out = (
    s
      // remove fenced code blocks (including ```mermaid)
      .replace(/```[\s\S]*?```/g, "")
      // footnote markers like [^S1]
      .replace(/\[\^S\d+\]/g, "")
      // footnote definition lines like [^S1]: ...
      .replace(/^\[\^S\d+\]:.*$/gm, "")
      // lines like ": token - https://..."
      .replace(/^\s*:\s*\w+\s*-\s*https?:\/\/\S+\s*$/gm, "")
      // headings
      .replace(/^#{1,6}\s+/gm, "")
      // bullet lists
      .replace(/^\s*[-*+]\s+/gm, "• ")
      // numbered lists
      .replace(/^\s*\d+\.\s+/gm, "")
      // inline code backticks
      .replace(/`([^`]+)`/g, "$1")
      // collapse many blank lines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );

  return out;
}

function sanitizeMarkdownForDisplay(md) {
  const s = String(md || "");
  const cleaned = s
    // remove fenced code blocks (including ```mermaid)
    .replace(/```[\s\S]*?```/g, "")
    // remove footnote markers and definitions
    .replace(/\[\^S\d+\]/g, "")
    .replace(/^\[\^S\d+\]:.*$/gm, "")
    // remove colon-source lines
    .replace(/^\s*:\s*\w+\s*-\s*https?:\/\/\S+\s*$/gm, "")
    // collapse extra blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const normalized = normalizeMarkdown(cleaned);
  return normalized;
}

function normalizeMarkdown(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (!line.trim()) {
      out.push("");
      continue;
    }
    // Normalize unordered list markers to "- "
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      out.push(`- ${ul[1].trim()}`);
      continue;
    }
    // Normalize ordered list markers to "1. " (Markdown auto-numbers)
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      out.push(`1. ${ol[1].trim()}`);
      continue;
    }
    // Remove leading indentation for normal text
    out.push(line.trimStart());
  }
  // collapse excessive blank lines
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function inlineMdToHtml(text) {
  // very small subset: code, bold, italic
  let t = escapeHtml(text);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return t;
}

function mdToSimpleHtml(md) {
  const text = String(md || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const out = [];
  let inUl = false;
  let inOl = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      const level = h[1].length;
      out.push(`<h${level}>${inlineMdToHtml(h[2])}</h${level}>`);
      continue;
    }
    const li = line.match(/^[-*+]\s+(.*)$/);
    if (li) {
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${inlineMdToHtml(li[1])}</li>`);
      continue;
    }
    const oli = line.match(/^\s*\d+\.\s+(.*)$/);
    if (oli) {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        out.push("<ol>");
        inOl = true;
      }
      out.push(`<li>${inlineMdToHtml(oli[1])}</li>`);
      continue;
    }
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
    out.push(`<p>${inlineMdToHtml(line)}</p>`);
  }
  if (inUl) out.push("</ul>");
  if (inOl) out.push("</ol>");
  return out.join("\n");
}

function renderNav(groups, onSelect) {
  navEl.innerHTML = "";
  for (const g of groups) {
    const group = document.createElement("div");
    group.className = "navGroup";
    const head = document.createElement("div");
    head.className = "navGroupHead";
    head.innerHTML = `<span class="stepBadge">${g.step}</span><span class="navGroupTitle">${escapeHtml(
      g.title
    )}</span>`;
    group.appendChild(head);
    for (const it of g.items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "navItem" + (it.sub ? " navItemSub" : "");
      btn.textContent = it.label;
      btn.dataset.key = it.key;
      btn.addEventListener("click", () => onSelect(it));
      group.appendChild(btn);
    }
    navEl.appendChild(group);
  }
}

function setActiveNav(key) {
  const buttons = Array.from(navEl.querySelectorAll("button.navItem"));
  for (const b of buttons) {
    b.classList.toggle("navItemActive", b.dataset.key === key);
  }
}

async function renderSopPlan(plan, jobId) {
  clearSop();
  if (!plan || !plan.sections) return;

  let evalCache = null;
  async function getEvalSuite() {
    if (evalCache) return evalCache;
    const res = await authFetch(`/api/jobs/${encodeURIComponent(jobId)}/eval`);
    evalCache = await res.json();
    return evalCache;
  }

  const groups = [];
  for (let idx = 0; idx < plan.sections.length; idx++) {
    const sec = plan.sections[idx];
    const step = idx + 1;
    const secItems = [];
    // section overview node
    secItems.push({
      key: `sec:${sec.title}`,
      label: "概览",
      sub: true,
      kind: "section",
      step,
      title: sec.title,
      instructions: sec.instructions || []
    });
    for (const it of sec.items || []) {
      if (String(it.path || "").startsWith("eval:")) {
        secItems.push({
          key: it.path,
          label: it.title,
          sub: true,
          kind: "eval",
          step,
          secTitle: sec.title,
          evalKey: it.path
        });
        continue;
      }
      secItems.push({
        key: it.path,
        label: it.title,
        sub: true,
        kind: "file",
        step,
        secTitle: sec.title,
        platform: it.platform,
        path: it.path
      });
    }
    groups.push({ step, title: sec.title, items: secItems });
  }

  let currentTextToCopy = "";
  copyBtnEl.style.display = "none";
  copyBtnEl.disabled = true;
  copyBtnEl.onclick = async () => {
    const ok = await copyText(currentTextToCopy);
    copyBtnEl.textContent = ok ? "已复制" : "复制失败";
    setTimeout(() => (copyBtnEl.textContent = "复制发布文案"), 1200);
  };

  async function selectNode(node) {
    setActiveNav(node.key);
    docKickerEl.textContent = node.step ? `步骤 ${node.step}` : "";

    if (node.kind === "section") {
      docTitleEl.textContent = node.title;
      docMetaEl.textContent = "这是执行说明（不是发布文案）。";
      const md = (node.instructions || []).map((x) => `- ${x}`).join("\n");
      currentTextToCopy = md;
      // Hide copy button for non-publish nodes (overview sections)
      copyBtnEl.style.display = "none";
      copyBtnEl.disabled = true;
      docBodyEl.innerHTML = mdToSimpleHtml(md);
      return;
    }

    if (node.kind === "eval") {
      docTitleEl.textContent = node.label;
      docMetaEl.textContent = "评测在本页面完成：复制问题 → 去平台提问 → 记录哪些问题能/不能命中公司名";
      copyBtnEl.style.display = "inline-block";
      copyBtnEl.disabled = true;
      docBodyEl.innerHTML = `<div class="docBlock">加载中…</div>`;
      const suite = await getEvalSuite();
      const questions = Array.isArray(suite.questions) ? suite.questions : [];

      const picked = questions.slice(0, 60);
      const md = [
        `## 问题集（复制去提问）`,
        ``,
        `建议每个平台先抽检 10-15 个问题，并在你的笔记里记录：是否提到公司名、是否描述正确、是否出现明显误解。`,
        ``,
        ...picked.map((q, i) => `${i + 1}. ${q.query}`)
      ].join("\n");

      currentTextToCopy = md;
      copyBtnEl.disabled = md.trim().length === 0;
      docBodyEl.innerHTML = mdToSimpleHtml(md);
      return;
    }

    docTitleEl.textContent = node.label;
    docMetaEl.textContent = `${node.platform} · 你可以直接复制右侧内容发布`;
    copyBtnEl.style.display = "inline-block";
    copyBtnEl.disabled = true;
    docBodyEl.innerHTML = `<div class="docBlock">加载中…</div>`;
    const url = `/api/jobs/${encodeURIComponent(jobId)}/file?path=${encodeURIComponent(node.path)}`;
    const md = await authFetch(url).then((r) => r.text());
    const sanitizedMd = sanitizeMarkdownForDisplay(md);
    currentTextToCopy = sanitizedMd; // copy markdown
    copyBtnEl.disabled = sanitizedMd.trim().length === 0;
    docBodyEl.innerHTML = mdToSimpleHtml(sanitizedMd); // render markdown consistently
  }

  renderNav(groups, (node) => void selectNode(node));
  // default: first file of first section if exists, else first section overview
  const first = groups[0]?.items.find((x) => x.kind === "file") || groups[0]?.items[0];
  if (first) await selectNode(first);
}

function currentPastes() {
  const items = Array.from(pastesEl.querySelectorAll("[data-paste='item']")).map((node) => {
    const title = node.querySelector("[name='pasteTitle']").value.trim();
    const emphasized = node.querySelector("[name='pasteEmphasized']").checked;
    const sourceUrl = node.querySelector("[name='pasteSourceUrl']").value.trim();
    const text = node.querySelector("[name='pasteText']").value;
    return { title, emphasized, sourceUrl, text };
  });
  return items.filter((x) => x.text && x.text.trim().length > 0);
}

function normLines(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function selectedQuestionAudiences() {
  const out = []
  if (audienceMarketEl?.checked) out.push("market_investor")
  if (audienceGovFundEl?.checked) out.push("gov_guidance_fund")
  return out
}

function buildGuidePaste() {
  const aliases = normLines(String(companyAliasesEl?.value || "").replace(/，/g, ",").replace(/;/g, ",").split(",").join("\n"));
  const oneLiner = String(companyOneLinerEl?.value || "").trim();
  const desired = normLines(desiredPerceptionEl?.value || "");
  const industry = String(industryEl?.value || "").trim();
  const product = String(productEl?.value || "").trim();
  const definition = String(productDefinitionEl?.value || "").trim();
  const audiences = selectedQuestionAudiences();
  const competitors = normLines(String(competitorsEl?.value || "").replace(/，/g, ",").replace(/;/g, ",").split(",").join("\n"));
  const questions = normLines(userQuestionsEl?.value || "");
  const mustBeTrue = normLines(mustBeTrueEl?.value || "");
  const avoid = normLines(claimsToAvoidEl?.value || "");

  // If user didn't fill anything, don't inject.
  const hasAny =
    aliases.length ||
    oneLiner ||
    desired.length ||
    industry ||
    product ||
    definition ||
    audiences.length ||
    competitors.length ||
    questions.length ||
    mustBeTrue.length ||
    avoid.length;
  if (!hasAny) return null;

  const md = [
    `# 公司定位与期望认知（用户填写）`,
    ``,
    industry ? `## 行业\n${industry}` : ``,
    product ? `## 产品/能力\n${product}` : ``,
    definition ? `## 产品定义\n${definition}` : ``,
    audiences.length
      ? `## 问法面向受众\n${audiences
          .map((a) => (a === "market_investor" ? "- 市场化投资人" : "- 政府引导基金"))
          .join("\n")}`
      : ``,
    oneLiner ? `## 一句话定位\n${oneLiner}` : ``,
    aliases.length ? `## 别名/常见写法\n- ${aliases.join("\n- ")}` : ``,
    desired.length ? `## 希望大模型如何描述我们（必须出现）\n- ${desired.join("\n- ")}` : ``,
    competitors.length ? `## 竞品/替代方案\n- ${competitors.join("\n- ")}` : ``,
    questions.length ? `## 典型用户问法（覆盖问法族）\n${questions.map((q) => `- ${q}`).join("\n")}` : ``,
    mustBeTrue.length ? `## 必须准确的事实（合规边界）\n- ${mustBeTrue.join("\n- ")}` : ``,
    avoid.length ? `## 不能说/容易被误解的点（合规边界）\n- ${avoid.join("\n- ")}` : ``,
    ``
  ]
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!md) return null;
  return { title: "向导信息（优先证据块）", emphasized: true, sourceUrl: "", text: md };
}

function buildPlainTextEvidencePaste() {
  const text = String(plainTextEvidenceEl?.value || "").trim();
  if (!text) return null;
  return { title: "纯文本资料片段", emphasized: true, sourceUrl: "", text };
}

function syncHiddenJson() {
  const guide = buildGuidePaste();
  const blocks = currentPastes();
  const plain = buildPlainTextEvidencePaste();
  if (plain) blocks.unshift(plain);
  if (guide) blocks.unshift(guide);
  pastedBlocksJsonEl.value = JSON.stringify(blocks);
}

function addPaste(initial = {}) {
  const wrap = document.createElement("div");
  wrap.className = "pasteItem";
  wrap.dataset.paste = "item";
  wrap.innerHTML = `
    <div class="inline" style="justify-content: space-between">
      <div class="inline">
        <strong style="font-size: 13px">补充材料</strong>
        <label style="margin: 0; display: inline-flex; align-items: center; gap: 8px;">
          <input type="checkbox" name="pasteEmphasized" />
          重点强调（生成时优先）
        </label>
      </div>
      <button type="button" class="btn btnDanger" data-action="remove">删除</button>
    </div>
    <div class="row">
      <div>
        <label>标题/用途（可选）</label>
        <input type="text" name="pasteTitle" placeholder="例如：一句话定位 / 核心卖点 / 合规声明" />
      </div>
      <div>
        <label>来源链接（可选）</label>
        <input type="text" name="pasteSourceUrl" placeholder="如果这段来自某页面，可填 URL" />
      </div>
    </div>
    <label>内容（可粘贴多段，越接近可公开发布越好）</label>
    <textarea name="pasteText" placeholder="在这里粘贴你想强调的内容"></textarea>
  `;

  wrap.querySelector("[name='pasteTitle']").value = initial.title || "";
  wrap.querySelector("[name='pasteEmphasized']").checked = Boolean(initial.emphasized);
  wrap.querySelector("[name='pasteSourceUrl']").value = initial.sourceUrl || "";
  wrap.querySelector("[name='pasteText']").value = initial.text || "";

  wrap.addEventListener("input", syncHiddenJson);
  wrap.addEventListener("change", syncHiddenJson);
  wrap.querySelector("[data-action='remove']").addEventListener("click", () => {
    wrap.remove();
    syncHiddenJson();
  });

  pastesEl.appendChild(wrap);
  syncHiddenJson();
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function isDupUpload(f) {
  return uploadFileBucket.some(
    (x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified
  );
}

function setUploadHint(text) {
  if (uploadHintEl) uploadHintEl.textContent = text || "";
}

function renderUploadFileList() {
  if (!uploadFileListEl) return;
  uploadFileListEl.innerHTML = "";
  if (uploadFileBucket.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sub";
    empty.style.margin = "0";
    empty.textContent = `尚未选择文件。可多选；需要再加时再次点「选择文件」即可累加（最多 ${MAX_UPLOAD_FILES} 个）。`;
    uploadFileListEl.appendChild(empty);
    return;
  }
  for (const file of uploadFileBucket) {
    const row = document.createElement("div");
    row.className = "uploadChip";
    const nameSpan = document.createElement("span");
    nameSpan.className = "uploadChipName";
    nameSpan.title = file.name;
    nameSpan.textContent = file.name;
    const metaSpan = document.createElement("span");
    metaSpan.className = "uploadChipMeta";
    metaSpan.textContent = fmtBytes(file.size);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btnDanger btnTiny";
    btn.textContent = "移除";
    btn.addEventListener("click", () => {
      const i = uploadFileBucket.indexOf(file);
      if (i >= 0) uploadFileBucket.splice(i, 1);
      renderUploadFileList();
      setUploadHint("");
    });
    row.appendChild(nameSpan);
    row.appendChild(metaSpan);
    row.appendChild(btn);
    uploadFileListEl.appendChild(row);
  }
}

function mergePickedUploadFiles(files) {
  let added = 0;
  let skippedDup = 0;
  let skippedCap = 0;
  for (const f of files) {
    if (uploadFileBucket.length >= MAX_UPLOAD_FILES) {
      skippedCap += 1;
      continue;
    }
    if (isDupUpload(f)) {
      skippedDup += 1;
      continue;
    }
    uploadFileBucket.push(f);
    added += 1;
  }
  const parts = [];
  if (added) parts.push(`已添加 ${added} 个文件`);
  if (skippedDup) parts.push(`跳过 ${skippedDup} 个重复`);
  if (skippedCap) parts.push(`已达 ${MAX_UPLOAD_FILES} 个上限，另有 ${skippedCap} 个未加入`);
  setUploadHint(parts.join("；"));
}

if (uploadInputEl) {
  uploadInputEl.addEventListener("change", () => {
    const picked = Array.from(uploadInputEl.files || []);
    mergePickedUploadFiles(picked);
    uploadInputEl.value = "";
    renderUploadFileList();
  });
}
clearUploadBtn?.addEventListener("click", () => {
  uploadFileBucket = [];
  renderUploadFileList();
  setUploadHint("");
});

renderUploadFileList();

addPasteBtn?.addEventListener?.("click", () => addPaste());
resetBtn.addEventListener("click", () => {
  formEl.reset();
  pastesEl.innerHTML = "";
  addPaste();
  if (plainTextEvidenceEl) plainTextEvidenceEl.value = "";
  uploadFileBucket = [];
  renderUploadFileList();
  setUploadHint("");
  setStatus("");
  setDownload("");
  setSopVisible(false);
  filesHintEl.textContent = "";
  clearSop();
});

addPaste({
  title: "一句话定位",
  emphasized: true,
  text: ""
});

function setStepActive(step) {
  const s = Math.max(1, Math.min(TOTAL_STEPS, Number(step) || 1));
  if (wizardStepEl) wizardStepEl.value = String(s);

  for (const el of wizardSteps) {
    const n = Number(el.getAttribute("data-step") || "0");
    el.classList.toggle("wizardStepActive", n === s);
  }

  if (wizardMetaEl) wizardMetaEl.textContent = `步骤 ${s} / ${TOTAL_STEPS}`;
  if (prevStepBtn) prevStepBtn.disabled = s <= 1;
  if (nextStepBtn) nextStepBtn.style.display = s >= TOTAL_STEPS ? "none" : "inline-block";

  const pills = Array.from(document.querySelectorAll("[data-step-pill]"));
  for (const p of pills) {
    const n = Number(p.getAttribute("data-step-pill") || "0");
    p.classList.toggle("stepPillActive", n === s);
  }

  // live summary
  if (wizardSummaryEl) {
    const company = String($("#companyName")?.value || "").trim();
    const oneLiner = String(companyOneLinerEl?.value || "").trim();
    const desiredAll = normLines(desiredPerceptionEl?.value || "");
    const qsAll = normLines(userQuestionsEl?.value || "");
    const desired = desiredAll.slice(0, 6);
    const qs = qsAll.slice(0, 6);
    const chips = [];
    if (company) chips.push(`公司：${company}`);
    if (oneLiner) chips.push(`定位：${oneLiner}`);
    if (desiredAll.length) chips.push(`期望认知：${desiredAll.length} 条`);
    if (qsAll.length) chips.push(`用户问法：${qsAll.length} 条`);
    wizardSummaryEl.innerHTML = `<strong>即将生成：</strong>系统会把你前面填写的问法/定位/期望认知/边界自动作为“重点强调材料”加入生成。${
      chips.length ? `<br /><br /><span style="color: var(--muted)">${chips.join(" · ")}</span>` : ""
    }`;
  }

  // keep hidden json up to date (guide injection depends on wizard fields)
  syncHiddenJson();
}

function step1Validate() {
  const missing = [];
  const company = String($("#companyName")?.value || "").trim();
  if (!company) missing.push("公司名");
  return { ok: missing.length === 0, missing };
}

function validateStep(step) {
  const s = Number(step) || 1;
  if (s === 1) return step1Validate();
  if (s === 2) {
    const company = String($("#companyName")?.value || "").trim();
    const oneLiner = String(companyOneLinerEl?.value || "").trim();
    const desired = normLines(desiredPerceptionEl?.value || "");
    const missing = [];
    if (!company) missing.push("公司名");
    if (!oneLiner) missing.push("一句话定位");
    if (desired.length < 3) missing.push("期望认知（至少 3 条）");
    return { ok: missing.length === 0, missing };
  }
  return { ok: true, missing: [] };
}

function goNext() {
  const cur = Number(wizardStepEl?.value || "1") || 1;
  const check = validateStep(cur);
  if (!check.ok) {
    setStatus(`请先补全：${check.missing.join("、")}`);
    return;
  }
  setStatus("");
  setStepActive(cur + 1);
}

function goPrev() {
  const cur = Number(wizardStepEl?.value || "1") || 1;
  setStatus("");
  setStepActive(cur - 1);
}

prevStepBtn?.addEventListener("click", goPrev);
nextStepBtn?.addEventListener("click", goNext);
stepperEl?.addEventListener("click", (e) => {
  const el = e.target?.closest?.("[data-step-pill]");
  if (!el) return;
  const n = Number(el.getAttribute("data-step-pill") || "1");
  // allow jumping back freely; jumping forward requires current step validation
  const cur = Number(wizardStepEl?.value || "1") || 1;
  if (n > cur) {
    const check = validateStep(cur);
    if (!check.ok) {
      setStatus(`请先补全：${check.missing.join("、")}`);
      return;
    }
  }
  setStatus("");
  setStepActive(n);
});

// keep guide paste updated when typing
for (const el of [
  $("#companyName"),
  industryEl,
  productEl,
  productDefinitionEl,
  companyAliasesEl,
  companyOneLinerEl,
  desiredPerceptionEl,
  audienceMarketEl,
  audienceGovFundEl,
  competitorsEl,
  userQuestionsEl,
  plainTextEvidenceEl,
  mustBeTrueEl,
  claimsToAvoidEl
]) {
  el?.addEventListener?.("input", () => syncHiddenJson());
  el?.addEventListener?.("change", () => syncHiddenJson());
}

setStepActive(1);

async function generateQuestions() {
  if (!genQuestionsBtn) return;
  const questionAudiences = selectedQuestionAudiences();
  if (!questionAudiences.length) {
    setStatus("请至少勾选一类受众：市场化投资人 或 政府引导基金。");
    return;
  }
  genQuestionsBtn.disabled = true;
  const oldText = genQuestionsBtn.textContent;
  genQuestionsBtn.textContent = "生成中…";
  try {
    const payload = {
      companyName: String($("#companyName")?.value || "").trim(),
      industry: String(industryEl?.value || "").trim(),
      product: String(productEl?.value || "").trim(),
      definition: String(productDefinitionEl?.value || "").trim(),
      competitors: String(competitorsEl?.value || "").trim(),
      questionAudiences
    };
    const res = await authFetch("/api/suggest_questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const qs = Array.isArray(data.questions) ? data.questions : [];
    const text = qs.join("\n");
    if (userQuestionsEl) userQuestionsEl.value = text;
    syncHiddenJson();
    const score = typeof data.score === "number" ? data.score : null;
    const qualityOk = data.qualityOk === true;
    const att = typeof data.attempts === "number" ? data.attempts : null;
    const hintLine =
      Array.isArray(data.hints) && data.hints.length
        ? ` 建议：${data.hints.slice(0, 2).join("；")}`
        : "";
    if (qs.length) {
      const tier = qualityOk ? "达标" : "未达 80";
      const scorePart = score != null ? `质量分 ${score}（${tier}）` : "已生成";
      const attPart = att != null ? ` · 共尝试 ${att} 轮` : "";
      setStatus(`已生成问法：${qs.length} 条（可继续编辑）· ${scorePart}${attPart}.${qualityOk ? "" : hintLine}`);
    } else {
      setStatus("生成完成，但没有返回问题");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`生成问法失败：${msg}`);
  } finally {
    genQuestionsBtn.disabled = false;
    genQuestionsBtn.textContent = oldText || "一键生成问法";
  }
}

genQuestionsBtn?.addEventListener?.("click", () => void generateQuestions());

async function pollJob(jobId) {
  const t0 = Date.now();
  while (true) {
    const res = await authFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (!res.ok) {
      const text = await res.text();
      setStatus(`状态：error\n${text}`);
      return;
    }
    const data = await res.json();
    const elapsed = Math.floor((Date.now() - t0) / 1000);
    const head = `状态：${data.status}（${elapsed}s）`;
    const detail = data.message ? `\n${data.message}` : "";
    setStatus(head + detail);

    if (data.status === "done") {
      const baseZipUrl = `/api/jobs/${encodeURIComponent(jobId)}/download`;
      const token = getAccessToken();
      const zipUrl = token ? `${baseZipUrl}?access_token=${encodeURIComponent(token)}` : baseZipUrl;
      zipLinkEl.href = zipUrl;
      zipLinkEl.setAttribute("download", "");

      filesHintEl.textContent =
        "按下面顺序执行：每个部分都包含对应平台的具体发布文案（纯文本，可直接复制）。";

      setSopVisible(true);
      try {
        const planRes = await authFetch(`/api/jobs/${encodeURIComponent(jobId)}/sop_plan`);
        const plan = await planRes.json();
        await renderSopPlan(plan, jobId);
      } catch {
        clearSop();
        docTitleEl.textContent = "加载失败";
        docBodyEl.innerHTML = `<div class="docBlock">SOP 加载失败，请刷新页面后重试。</div>`;
      }

      setDownload(
        `已完成。<a href="${zipUrl}" download>下载 zip（备份）</a>`
      );
      return;
    }
    if (data.status === "error") return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

formEl.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const check = validateStep(2);
  if (!check.ok) {
    setStatus(`请先补全：${check.missing.join("、")}`);
    setStepActive(2);
    return;
  }
  setDownload("");
  setSopVisible(false);
  filesHintEl.textContent = "";
  clearSop();
  syncHiddenJson();

  const fd = new FormData(formEl);
  for (const f of uploadFileBucket) {
    fd.append("uploadFiles", f);
  }
  setStatus("提交任务中…");

  const res = await authFetch("/api/jobs", { method: "POST", body: fd });
  if (!res.ok) {
    const text = await res.text();
    setStatus(`提交失败：${text}`);
    return;
  }
  const data = await res.json();
  if (!data.jobId) {
    setStatus("提交失败：没有返回 jobId");
    return;
  }
  await pollJob(data.jobId);
});

// Access gate boot:
// - If token exists, validate silently and skip the gate.
// - Otherwise show the gate.
void (async () => {
  const token = getAccessToken();
  if (!token) {
    showGate("");
    return;
  }
  try {
    const res = await authFetch("/healthz");
    if (res.ok) {
      hideGate();
      return;
    }
  } catch {}
  setAccessToken("");
  showGate("密码不正确或已过期，请重新输入。");
})();

