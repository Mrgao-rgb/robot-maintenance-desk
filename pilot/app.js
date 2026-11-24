"use strict";

const pilot = window.MaintenancePilot;
const storageKey = "robot-maintenance-pilot-v1";
const byId = (id) => document.getElementById(id);
const sections = {
  devices: byId("device-list"),
  current: byId("current-device"),
  triage: byId("triage-form"),
  draft: byId("draft-panel"),
  evidence: byId("evidence-panel"),
  history: byId("history-panel"),
  message: byId("message"),
};

let state = pilot.createInitialState();
let startupMessage = "";
let storageFailed = false;
let savedData = null;
try {
  savedData = localStorage.getItem(storageKey);
  if (savedData) state = pilot.validateState(JSON.parse(savedData));
} catch {
  storageFailed = true;
  startupMessage = "无法读取此浏览器中的备份。可以先体验示例，或导入一份有效的试用数据。";
}

let selectedId = state.devices[0]?.id;
let draft = null;
let retestId = null;

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function button(label, style, onClick) {
  const node = element("button", `button button-${style}`, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function details(label, value) {
  const container = element("div", "kv");
  container.append(element("dt", "muted", label), element("dd", "", value));
  return container;
}

function list(items) {
  const result = element("ul", "plain-list");
  for (const item of items) result.append(element("li", "", item));
  return result;
}

function dateLabel(time) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(time));
}

function configurationLabel(snapshot) {
  return `${snapshot.keyComponent} ${snapshot.version || "版本待确认"}`;
}

function announce(message, isError = false) {
  sections.message.textContent = message;
  sections.message.classList.toggle("is-error", isError);
  if (isError && message) sections.message.scrollIntoView({ block: "nearest" });
}

function currentDevice() {
  return state.devices.find((device) => device.id === selectedId);
}

function renderDevices() {
  sections.devices.replaceChildren();
  for (const device of state.devices) {
    const active = device.id === selectedId;
    const item = element("button", `device-item${active ? " is-selected" : ""}`);
    item.type = "button";
    item.setAttribute("aria-pressed", String(active));
    item.append(
      element("strong", "", device.name),
      element("span", "device-meta", `${device.simulated ? "模拟 · " : ""}${device.model}`),
    );
    item.addEventListener("click", () => selectDevice(device.id, true));
    sections.devices.append(item);
  }
}

function renderCurrent(device) {
  sections.current.replaceChildren();
  if (!device) {
    sections.current.append(element("p", "empty", "先新增一台设备，再录入当前配置。"));
    return;
  }
  const title = element("div", "cluster device-title");
  title.append(
    element("h2", "", device.name),
    element("span", device.simulated ? "tag" : "tag is-success", device.simulated ? "模拟设备" : "自有设备"),
  );
  const fields = element("dl", "device-fields");
  fields.append(details("设备型号", device.model), details("关键部件", device.keyComponent), details("当前版本", device.version || "待确认"));
  const change = [...state.activity].reverse().find((event) => event.type === "device-version-changed" && event.deviceId === device.id);
  const actions = element("div", "cluster configuration-actions");
  actions.append(button("登记配置变更", "secondary", () => {
    const form = byId("version-form");
    form.reset();
    form.elements.namedItem("version").value = currentDevice()?.version || "";
    byId("version-dialog").showModal();
  }));
  const recent = change ? `最近变更 ${dateLabel(change.createdAt)} · ${change.beforeVersion || "未知"} 改为 ${change.afterVersion || "未知"}` : "配置尚无变更记录";
  actions.append(element("span", "muted", recent));
  sections.current.append(title, fields, actions);
}

function referenceRow(reference, muted = false) {
  const card = element("article", muted ? "evidence-item is-muted" : "evidence-item");
  const heading = element("div", "cluster evidence-heading");
  heading.append(element("strong", "", reference.title));
  const badge = muted
    ? element("span", "tag is-warning", reference.reasonText)
    : element("span", "tag is-success", reference.version === null ? "通用资料" : `适用 ${reference.version}`);
  heading.append(badge);
  card.append(heading, element("p", "muted source-locator", `${reference.keyComponent} · ${reference.locator}`));
  if (!muted) card.append(element("p", "source-excerpt", reference.excerpt));
  return card;
}

function renderEvidence(device) {
  sections.evidence.replaceChildren();
  if (!device) {
    sections.evidence.append(element("p", "empty", "选定设备后查看资料。"));
    return;
  }
  const { applicable, excluded, pendingReason } = pilot.getApplicability(state, device.id);
  if (pendingReason === "unknown-version") {
    sections.evidence.append(element("p", "pending-note", "关键部件版本待确认。明确标为通用的资料仍可查看。"));
  }
  if (!applicable.length) sections.evidence.append(element("p", "empty", "暂无适用资料。可添加手册摘录或维护记录作为依据。"));
  for (const reference of applicable) sections.evidence.append(referenceRow(reference));
  const comparable = excluded.filter((reference) => reference.reason !== "model-mismatch");
  if (comparable.length) {
    const group = element("details", "excluded-evidence");
    group.open = true;
    group.append(element("summary", "muted", `未用于当前配置（${comparable.length}）`));
    const rows = element("div", "stack");
    for (const reference of comparable) rows.append(referenceRow(reference, true));
    group.append(rows);
    sections.evidence.append(group);
  }
}

function renderDraft() {
  sections.draft.replaceChildren();
  if (!draft) {
    sections.draft.append(element("p", "empty", "描述现场现象后，这里会显示待核实项和工单草稿。"));
    return;
  }
  const card = element("div", "draft-card stack");
  const heading = element("div", "cluster");
  const isStale = currentDevice()?.configRevision !== draft.snapshot.configRevision;
  heading.append(
    element("h3", "", "工单草稿"),
    element("span", draft.status === "ready" && !isStale ? "tag is-success" : "tag is-warning", isStale ? "配置已变更" : draft.status === "ready" ? "可审阅" : "有待核实项"),
  );
  card.append(heading, element("p", "muted", `起草时的配置 · ${configurationLabel(draft.snapshot)}`));
  if (isStale) card.append(element("p", "pending-note", "请按当前配置重新生成草稿，核对引用后再提交。"));
  const label = element("label", "stack", "工单现象");
  const input = element("textarea");
  input.rows = 2;
  input.value = draft.description;
  input.maxLength = 3000;
  input.addEventListener("input", () => { draft.description = input.value; });
  label.append(input);
  card.append(label);
  if (draft.questions.length) {
    card.append(element("h4", "", "待核实"), list(draft.questions));
  }
  if (draft.checks.length) {
    card.append(element("h4", "", "检查与复测记录项"), list(draft.checks));
  }
  if (draft.references.length) {
    card.append(element("h4", "", "草稿引用"), list(draft.references.map((reference) => `${reference.title} · ${reference.locator}`)));
  }
  const confirm = button("确认生成工单", "primary", () => {
    const editedDraft = { ...draft, description: input.value };
    confirm.disabled = true;
    runAction(async () => {
      const order = await commit((updated) => pilot.commitDraft(updated, editedDraft));
      draft = null;
      sections.triage.reset();
      render();
      announce(`工单 ${order.id} 已保存。`, false);
      sections.history.scrollIntoView({ block: "nearest" });
    }).finally(() => { confirm.disabled = isStale; });
  });
  confirm.disabled = isStale;
  const actions = element("div", "cluster");
  actions.append(confirm, button("舍弃草稿", "quiet", () => {
    draft = null;
    renderDraft();
    announce("已舍弃草稿。");
  }));
  card.append(actions);
  sections.draft.append(card);
}

function renderHistory(device) {
  sections.history.replaceChildren();
  const workOrders = state.workOrders.filter((order) => order.deviceId === device?.id).reverse();
  if (!workOrders.length) {
    sections.history.append(element("p", "empty", "此设备还没有工单。确认草稿后，可在这里记录复测。"));
    return;
  }
  for (const order of workOrders) {
    const card = element("article", "record stack");
    const heading = element("div", "cluster record-heading");
    heading.append(element("strong", "", order.id), element("span", order.status === "closed" ? "tag is-success" : "tag is-warning", order.status === "closed" ? "已结单" : "待跟进"));
    card.append(
      heading,
      element("p", "", order.description),
      element("p", "muted", `${dateLabel(order.createdAt)} · 工单配置 · ${configurationLabel(order.snapshot)}`),
    );
    if (order.references.length) {
      const group = element("details", "record-sources");
      group.append(element("summary", "", `工单引用（${order.references.length}）`), list(order.references.map((reference) => `${reference.title} · ${reference.locator}`)));
      card.append(group);
    }
    for (const retest of order.retests) {
      const entry = element("div", "retest-entry");
      entry.append(
        element("strong", "", retest.passed ? "复测通过" : "复测未通过"),
        element("p", "", retest.result),
        element("p", "muted", `${dateLabel(retest.createdAt)} · 复测配置 · ${configurationLabel(retest.snapshot)}`),
      );
      card.append(entry);
    }
    if (order.status === "open") {
      card.append(button("记录复测", "secondary", () => {
        retestId = order.id;
        byId("retest-form").reset();
        syncRetestForm();
        byId("retest-dialog").showModal();
      }));
    }
    sections.history.append(card);
  }
}

function render() {
  const device = currentDevice();
  renderDevices();
  renderCurrent(device);
  renderEvidence(device);
  renderDraft();
  renderHistory(device);
  for (const control of sections.triage.elements) control.disabled = !device;
}

function selectDevice(id, focus) {
  if (id !== selectedId) {
    if (draft && !window.confirm("切换设备会舍弃当前未提交的草稿。继续切换？")) return;
    selectedId = id;
    draft = null;
    sections.triage.reset();
  }
  render();
  announce("");
  if (focus) sections.devices.querySelector('[aria-pressed="true"]')?.focus();
}

async function runAction(action, errorField) {
  if (errorField) errorField.hidden = true;
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作未完成，请重试。";
    if (errorField) {
      errorField.textContent = message;
      errorField.hidden = false;
    } else announce(message, true);
  }
}

function storeState(updated) {
  const serial = JSON.stringify(updated);
  try {
    localStorage.setItem(storageKey, serial);
  } catch {
    throw new Error("浏览器暂时无法保存数据。请导出已有数据，再检查浏览器存储空间或权限。");
  }
  storageFailed = false;
  savedData = serial;
  state = updated;
}

function withStorageLock(action) {
  return navigator.locks ? navigator.locks.request(storageKey, action) : action();
}

function commit(change) {
  return withStorageLock(() => {
    if (storageFailed) throw new Error("请先导入有效备份以恢复工作区，避免覆盖无法读取的数据。");
    const latest = localStorage.getItem(storageKey);
    if (latest !== savedData) {
      if (!latest) throw new Error("此工作区的数据已被清除，请重新打开页面或导入备份。");
      state = pilot.validateState(JSON.parse(latest));
      savedData = latest;
      if (!currentDevice()) {
        selectedId = state.devices[0]?.id;
        draft = null;
      }
      render();
      throw new Error("另一标签页刚刚更新了数据。请核对页面中的记录后再提交。");
    }
    const updated = structuredClone(state);
    const result = change(updated);
    storeState(updated);
    return result;
  });
}

function handleForm(id, handler) {
  const form = byId(id);
  const modal = form.closest("dialog");
  const errorField = modal ? element("p", "form-error") : null;
  if (errorField) {
    errorField.hidden = true;
    errorField.setAttribute("role", "alert");
    form.querySelector(".dialog-body").append(errorField);
    modal.addEventListener("close", () => { errorField.hidden = true; });
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    runAction(() => handler(values, form), errorField).finally(() => {
      if (submit) submit.disabled = false;
    });
  });
}

function syncRetestForm() {
  const form = byId("retest-form");
  const close = form.elements.namedItem("close");
  close.disabled = form.elements.namedItem("passed").value !== "yes";
  if (close.disabled) close.checked = false;
}

function syncDocumentForm() {
  const form = byId("document-form");
  const version = form.elements.namedItem("version");
  version.disabled = form.elements.namedItem("allVersions").checked;
  version.required = !version.disabled;
}

document.querySelectorAll("[data-close-dialog]").forEach((control) => {
  control.addEventListener("click", () => control.closest("dialog").close());
});

byId("select-add-device").addEventListener("click", () => {
  if (draft && !window.confirm("新增设备会舍弃当前未提交的草稿。继续新增？")) return;
  byId("device-form").reset();
  byId("device-dialog").showModal();
});

byId("open-document").addEventListener("click", () => {
  const form = byId("document-form");
  form.reset();
  if (currentDevice()) {
    form.elements.namedItem("model").value = currentDevice().model;
    form.elements.namedItem("keyComponent").value = currentDevice().keyComponent;
    form.elements.namedItem("version").value = currentDevice().version;
  }
  syncDocumentForm();
  byId("document-dialog").showModal();
});

byId("document-form").elements.namedItem("allVersions").addEventListener("change", syncDocumentForm);
byId("retest-form").elements.namedItem("passed").addEventListener("change", syncRetestForm);

handleForm("device-form", async (values, form) => {
  const device = await commit((updated) => pilot.addDevice(updated, values));
  selectedId = device.id;
  draft = null;
  sections.triage.reset();
  form.closest("dialog").close();
  render();
  announce(`已登记 ${device.name}。`);
});

handleForm("version-form", async (values, form) => {
  const deviceId = selectedId;
  await commit((updated) => pilot.updateDeviceVersion(updated, { deviceId, version: values.version }));
  form.closest("dialog").close();
  render();
  announce("当前配置已保存。");
});

handleForm("document-form", async (values, form) => {
  const version = form.elements.namedItem("allVersions").checked ? null : values.version;
  await commit((updated) => pilot.addDocument(updated, { ...values, version }));
  form.closest("dialog").close();
  render();
  announce("资料已保存。重新生成草稿可纳入最新资料。");
});

handleForm("triage-form", (values) => {
  draft = pilot.createDraft(state, { deviceId: selectedId, description: values.description });
  renderDraft();
  announce("草稿已生成，请核对引用和待核实事项。");
});

handleForm("retest-form", async (values, form) => {
  const workOrderId = retestId;
  const close = form.elements.namedItem("close").checked;
  const order = await commit((updated) => pilot.recordRetest(updated, {
    workOrderId,
    result: values.result,
    passed: values.passed === "yes",
    close,
  }));
  form.closest("dialog").close();
  render();
  announce(order.status === "closed" ? "复测已保存，工单已结单。" : "复测已保存，工单继续跟进。");
});

byId("export-data").addEventListener("click", () => runAction(() => {
  const file = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = element("a");
  link.href = url;
  link.download = `maintenance-pilot-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  announce("试用数据已导出。备份可在同版本维护台导入。");
}));

byId("import-data").addEventListener("click", () => byId("import-file").click());
byId("import-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("备份文件超过 10 MB。请选择较小的试用备份。");
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error("无法读取此 JSON 备份，请检查文件格式。");
    }
    const updated = pilot.validateState(parsed);
    if (!window.confirm(`导入「${file.name}」会替换本浏览器中的试用记录。请先导出需要保留的记录。确认替换？`)) return;
    await withStorageLock(() => storeState(updated));
    draft = null;
    selectedId = state.devices[0]?.id;
    sections.triage.reset();
    render();
    announce("备份已导入。");
  } catch (error) {
    announce(error instanceof Error ? error.message : "导入未完成。", true);
  }
});

render();
if (startupMessage) announce(startupMessage, true);
