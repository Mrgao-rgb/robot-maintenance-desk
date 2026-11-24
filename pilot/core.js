(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MaintenancePilot = api;
  }
})(typeof window === "undefined" ? null : window, function () {
  "use strict";

  const SCHEMA_VERSION = 1;
  const DEFAULT_DESCRIPTION = "前进指令下右腿动作不稳定，待复测。";
  const ACTIVITY_TYPES = [
    "device-added",
    "device-version-changed",
    "document-added",
    "work-order-created",
    "retest-recorded",
    "work-order-closed",
  ];
  let fallbackId = 0;

  function makeId(prefix) {
    const uniqueId = globalThis.crypto?.randomUUID?.();
    if (uniqueId) {
      return `${prefix}-${uniqueId}`;
    }
    fallbackId += 1;
    return `${prefix}-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
  }

  function requiredText(value, label) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`请填写${label}。`);
    }
    return value.trim().normalize("NFC");
  }

  function deviceVersion(value) {
    if (typeof value !== "string") {
      throw new Error("设备版本应为文字，未知时可留空。");
    }
    return value.trim().normalize("NFC");
  }

  function takeSnapshot(device) {
    return {
      deviceId: device.id,
      deviceName: device.name,
      model: device.model,
      keyComponent: device.keyComponent,
      version: device.version,
      configRevision: device.configRevision,
    };
  }

  function findDevice(state, deviceId) {
    const device = state.devices.find((item) => item.id === deviceId);
    if (!device) {
      throw new Error("找不到这台设备。");
    }
    return device;
  }

  function addActivity(state, type, entityId, deviceId, createdAt, summary, details = {}) {
    state.activity.push({
      id: makeId("ACT"),
      type,
      entityId,
      deviceId,
      createdAt,
      summary,
      ...details,
    });
  }

  function addDevice(state, input) {
    const device = {
      id: makeId("DEV"),
      name: requiredText(input.name, "设备名称"),
      model: requiredText(input.model, "设备型号"),
      keyComponent: requiredText(input.keyComponent, "关键部件"),
      version: deviceVersion(input.version ?? ""),
      configRevision: 1,
      simulated: input.simulated === true,
    };
    state.devices.push(device);
    addActivity(state, "device-added", device.id, device.id, new Date().toISOString(), `登记了设备「${device.name}」。`);
    return device;
  }

  function updateDeviceVersion(state, input) {
    const device = findDevice(state, input.deviceId);
    const beforeVersion = device.version;
    const afterVersion = deviceVersion(input.version);
    if (beforeVersion === afterVersion) {
      return device;
    }
    const configRevision = configurationRevision(device.configRevision + 1);
    device.version = afterVersion;
    device.configRevision = configRevision;
    addActivity(
      state, "device-version-changed", device.id, device.id, new Date().toISOString(),
      `「${device.name}」的${device.keyComponent}从「${beforeVersion || "未知"}」更新为「${afterVersion || "未知"}」。`,
      { beforeVersion, afterVersion },
    );
    return device;
  }

  function documentFields(input) {
    return {
      title: requiredText(input.title, "资料标题"),
      model: requiredText(input.model, "资料适用型号"),
      keyComponent: requiredText(input.keyComponent, "资料适用关键部件"),
      version: input.version === null ? null : requiredText(input.version, "资料适用版本"),
      locator: requiredText(input.locator, "资料出处或章节"),
      excerpt: requiredText(input.excerpt, "资料摘录"),
    };
  }

  function addDocument(state, input) {
    const document = { id: makeId("DOC"), ...documentFields(input) };
    state.documents.push(document);
    addActivity(state, "document-added", document.id, null, new Date().toISOString(), `录入了资料「${document.title}」。`);
    return document;
  }

  function documentExclusion(document, snapshot) {
    if (document.model !== snapshot.model) {
      return { reason: "model-mismatch", reasonText: `资料适用型号为 ${document.model}。` };
    }
    if (document.keyComponent !== snapshot.keyComponent) {
      return { reason: "component-mismatch", reasonText: `资料适用部件为${document.keyComponent}。` };
    }
    if (document.version === null) {
      return null;
    }
    if (!snapshot.version) {
      return { reason: "unknown-version", reasonText: `当前${snapshot.keyComponent}版本待确认。` };
    }
    if (document.version !== snapshot.version) {
      return { reason: "version-mismatch", reasonText: `资料适用版本为 ${document.version}。` };
    }
    return null;
  }

  function getApplicability(state, deviceId) {
    const snapshot = takeSnapshot(findDevice(state, deviceId));
    const applicable = [];
    const excluded = [];
    for (const document of state.documents) {
      const exclusion = documentExclusion(document, snapshot);
      if (exclusion) {
        excluded.push({ ...document, ...exclusion });
      } else {
        applicable.push({ ...document });
      }
    }

    let pendingReason = null;
    if (!snapshot.version) {
      pendingReason = "unknown-version";
    } else if (applicable.length === 0) {
      pendingReason = "no-match";
    }
    return { snapshot, applicable, excluded, status: pendingReason ? "pending" : "ready", pendingReason };
  }

  function createDraft(state, input) {
    const description = requiredText(input.description, "故障现象");
    const applicability = getApplicability(state, input.deviceId);
    const { snapshot, applicable, excluded, status, pendingReason } = applicability;
    const questions = ["现象出现的时间、发生条件和重复频率是什么？"];
    const checks = ["记录实际观察到的现象、时间和测试条件。", "按人工确认的复测条件记录结果和未解决问题。"];
    if (pendingReason === "unknown-version") {
      questions.unshift(`这台设备当前装的${snapshot.keyComponent}是什么版本？`);
    }
    if (pendingReason === "no-match") {
      questions.unshift(`是否有适用于 ${snapshot.model} 的${snapshot.keyComponent}「${snapshot.version}」的可靠资料？`);
    }
    if (applicable.length > 0) {
      checks.splice(1, 0, "核对适用资料的出处，并在工单中保留现场确认结果。");
    }
    return {
      id: makeId("DRAFT"),
      deviceId: snapshot.deviceId,
      description,
      status,
      pendingReason,
      snapshot,
      references: applicable,
      excluded,
      questions,
      checks,
      createdAt: new Date().toISOString(),
    };
  }

  function sameSnapshot(first, second) {
    return first && Object.keys(second).every((field) => first[field] === second[field]);
  }

  function commitDraft(state, draft) {
    const draftId = requiredText(draft.id, "草稿编号");
    const existingOrder = state.workOrders.find((order) => order.draftId === draftId);
    if (existingOrder) {
      return existingOrder;
    }

    const description = requiredText(draft.description, "故障现象");
    const { snapshot, applicable } = getApplicability(state, draft.deviceId);
    if (!sameSnapshot(draft.snapshot, snapshot)) {
      throw new Error("设备配置已变更。请重新生成草稿并核对引用后提交。");
    }
    if (!Array.isArray(draft.references)) {
      throw new Error("草稿缺少资料引用信息。请重新生成草稿。");
    }
    const confirmedSourceIds = new Set(draft.references.map((reference) => reference.id));
    const references = applicable.filter((document) => confirmedSourceIds.has(document.id));
    if (references.length !== confirmedSourceIds.size) {
      throw new Error("草稿中的资料适用性已变更。请重新生成草稿并核对引用后提交。");
    }

    const createdAt = new Date().toISOString();
    const order = {
      id: makeId("WO"),
      draftId,
      deviceId: snapshot.deviceId,
      description,
      status: "open",
      createdAt,
      closedAt: null,
      snapshot,
      references,
      retests: [],
    };
    state.workOrders.push(order);
    addActivity(state, "work-order-created", order.id, order.deviceId, createdAt, `确认了「${snapshot.deviceName}」的工单。`);
    return order;
  }

  function recordRetest(state, input) {
    const order = state.workOrders.find((item) => item.id === input.workOrderId);
    if (!order) {
      throw new Error("找不到要复测的工单。");
    }
    if (order.status === "closed") {
      throw new Error("该工单已结单。");
    }
    const result = requiredText(input.result, "复测结果");
    if (typeof input.passed !== "boolean") {
      throw new Error("请选择复测是否通过。");
    }
    const closed = input.close === true;
    if (closed && !input.passed) {
      throw new Error("复测通过后才能结单。");
    }

    const snapshot = takeSnapshot(findDevice(state, order.deviceId));
    const createdAt = new Date().toISOString();
    const retest = { id: makeId("RT"), result, passed: input.passed, snapshot, createdAt, closed };
    order.retests.push(retest);
    addActivity(state, "retest-recorded", order.id, order.deviceId, createdAt, `记录了「${snapshot.deviceName}」的复测结果。`);
    if (closed) {
      order.status = "closed";
      order.closedAt = createdAt;
      addActivity(state, "work-order-closed", order.id, order.deviceId, createdAt, `「${snapshot.deviceName}」的工单已结单。`);
    }
    return order;
  }

  function createInitialState() {
    const robotModel = "LBA-DEMO-01";
    const fanModel = "FAN-DEMO-01";
    const originalVersion = "原装板 R1";
    const replacementVersion = "替换板 R2";
    const devices = [
      { id: "DEV-A", name: "罗本艾特玩具机器人 A", model: robotModel, keyComponent: "控制板", version: originalVersion, configRevision: 1, simulated: true },
      { id: "DEV-B", name: "罗本艾特玩具机器人 B", model: robotModel, keyComponent: "控制板", version: replacementVersion, configRevision: 2, simulated: true },
      { id: "DEV-C", name: "罗本艾特玩具机器人 C", model: robotModel, keyComponent: "控制板", version: "", configRevision: 1, simulated: true },
      { id: "DEV-FAN", name: "模拟台架风机", model: fanModel, keyComponent: "驱动模块", version: "F1", configRevision: 1, simulated: true },
    ];
    const documents = [
      { id: "DOC-R1", title: "原装板 R1 现象记录", model: robotModel, keyComponent: "控制板", version: originalVersion, locator: "自制演示资料《机器人报修记录》第 2 节", excerpt: "原装 R1 样例应在报修记录里关联原装板标签、现场观察和最近一次复测。" },
      { id: "DOC-R2", title: "替换板 R2 交接记录", model: robotModel, keyComponent: "控制板", version: replacementVersion, locator: "自制演示资料《板卡换件交接》第 3 节", excerpt: "替换 R2 样例使用换件后的交接记录。描述现象时记录已确认的新装配版本与复测日期。" },
      { id: "DOC-ALL", title: "机器人报修通用记录项", model: robotModel, keyComponent: "控制板", version: null, locator: "自制演示资料《机器人报修记录》第 1 节", excerpt: "记录复现时的条件、故障现象、是否近期换件和观察时间。通用于本型号各板卡版本。" },
      { id: "DOC-R0", title: "历史样机板 R0 记录", model: robotModel, keyComponent: "控制板", version: "样机板 R0", locator: "自制演示资料《样机历史归档》第 1 节", excerpt: "本节仅用于样机 R0 归档。现场复测记录需绑定其当时的样机版本。" },
      { id: "DOC-FAN", title: "风机 F1 维护记录", model: fanModel, keyComponent: "驱动模块", version: "F1", locator: "自制演示资料《台架风机巡检》第 2 节", excerpt: "适用于 F1 模拟风机。记录异常声音出现的时段、持续时间和复测结果。" },
    ];

    const previousSnapshot = takeSnapshot({ ...devices[1], version: originalVersion, configRevision: 1 });
    const confirmedAt = "2026-11-15T02:20:00.000Z";
    const retestedAt = "2026-11-16T06:00:00.000Z";
    const changedAt = "2026-11-18T03:30:00.000Z";
    const historicalOrder = {
      id: "WO-DEMO-01",
      draftId: "DRAFT-DEMO-01",
      deviceId: "DEV-B",
      description: "换件前归档原装控制板下的动作异常。",
      status: "closed",
      createdAt: confirmedAt,
      closedAt: retestedAt,
      snapshot: { ...previousSnapshot },
      references: [{ ...documents[0] }, { ...documents[2] }],
      retests: [{
        id: "RT-DEMO-01",
        result: "模拟复测通过，记录已归档。",
        passed: true,
        snapshot: { ...previousSnapshot },
        createdAt: retestedAt,
        closed: true,
      }],
    };
    const activity = [
      { id: "ACT-DEMO-01", type: "work-order-created", entityId: historicalOrder.id, deviceId: "DEV-B", createdAt: confirmedAt, summary: "确认了机器人 B 在原装板 R1 下的工单。" },
      { id: "ACT-DEMO-02", type: "retest-recorded", entityId: historicalOrder.id, deviceId: "DEV-B", createdAt: retestedAt, summary: "记录了机器人 B 的 R1 模拟复测结果。" },
      { id: "ACT-DEMO-03", type: "work-order-closed", entityId: historicalOrder.id, deviceId: "DEV-B", createdAt: retestedAt, summary: "机器人 B 在原装板 R1 下的工单已结单。" },
      { id: "ACT-DEMO-04", type: "device-version-changed", entityId: "DEV-B", deviceId: "DEV-B", createdAt: changedAt, summary: "机器人 B 的控制板从原装板 R1 更新为替换板 R2。", beforeVersion: originalVersion, afterVersion: replacementVersion },
    ];
    return { schemaVersion: SCHEMA_VERSION, devices, documents, workOrders: [historicalOrder], activity };
  }

  function record(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label}格式无效。`);
    }
    return value;
  }

  function collection(value, label, normalize) {
    if (!Array.isArray(value)) {
      throw new Error(`${label}格式无效。`);
    }
    const seen = new Set();
    return value.map((item) => {
      const normalized = normalize(record(item, label));
      if (seen.has(normalized.id)) {
        throw new Error(`${label}中有重复编号。`);
      }
      seen.add(normalized.id);
      return normalized;
    });
  }

  function configurationRevision(value) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("设备配置修订号无效。");
    }
    return value;
  }

  function booleanField(value, label) {
    if (typeof value !== "boolean") {
      throw new Error(`${label}格式无效。`);
    }
    return value;
  }

  function timestamp(value) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      throw new Error("记录时间格式无效。");
    }
    return new Date(value).toISOString();
  }

  function normalizeSnapshot(value) {
    const snapshot = record(value, "设备配置快照");
    return {
      deviceId: requiredText(snapshot.deviceId, "快照设备编号"),
      deviceName: requiredText(snapshot.deviceName, "快照设备名称"),
      model: requiredText(snapshot.model, "快照设备型号"),
      keyComponent: requiredText(snapshot.keyComponent, "快照关键部件"),
      version: deviceVersion(snapshot.version),
      configRevision: configurationRevision(snapshot.configRevision),
    };
  }

  function normalizeDocument(document) {
    return { id: requiredText(document.id, "资料编号"), ...documentFields(document) };
  }

  function normalizeWorkOrder(order) {
    const deviceId = requiredText(order.deviceId, "工单设备编号");
    const snapshot = normalizeSnapshot(order.snapshot);
    const references = collection(order.references, "工单资料引用", normalizeDocument);
    const retests = collection(order.retests, "工单复测记录", (retest) => ({
      id: requiredText(retest.id, "复测编号"),
      result: requiredText(retest.result, "复测结果"),
      passed: booleanField(retest.passed, "复测是否通过"),
      snapshot: normalizeSnapshot(retest.snapshot),
      createdAt: timestamp(retest.createdAt),
      closed: booleanField(retest.closed, "复测是否结单"),
    }));
    if (snapshot.deviceId !== deviceId || retests.some((retest) => retest.snapshot.deviceId !== deviceId)) {
      throw new Error("工单或复测的设备快照与工单设备不一致。");
    }
    if (references.some((reference) => documentExclusion(reference, snapshot))) {
      throw new Error("工单资料引用与工单设备配置不匹配。");
    }
    if (order.status !== "open" && order.status !== "closed") {
      throw new Error("工单状态无效。");
    }
    const closedAt = order.closedAt === null ? null : timestamp(order.closedAt);
    const closingRetests = retests.filter((retest) => retest.closed);
    if (order.status === "closed") {
      const lastRetest = retests.at(-1);
      if (closingRetests.length !== 1 || !lastRetest.closed || !lastRetest.passed || lastRetest.createdAt !== closedAt) {
        throw new Error("已结单工单缺少对应的通过复测记录。");
      }
    } else if (closedAt !== null || closingRetests.length > 0) {
      throw new Error("未结单工单含有结单记录。");
    }
    return {
      id: requiredText(order.id, "工单编号"),
      draftId: requiredText(order.draftId, "草稿编号"),
      deviceId,
      description: requiredText(order.description, "故障现象"),
      status: order.status,
      createdAt: timestamp(order.createdAt),
      closedAt,
      snapshot,
      references,
      retests,
    };
  }

  function validateState(input) {
    const state = record(input, "维护台备份");
    if (state.schemaVersion !== SCHEMA_VERSION) {
      throw new Error("维护台备份版本不受支持。");
    }
    const devices = collection(state.devices, "设备档案", (device) => ({
      id: requiredText(device.id, "设备编号"),
      name: requiredText(device.name, "设备名称"),
      model: requiredText(device.model, "设备型号"),
      keyComponent: requiredText(device.keyComponent, "关键部件"),
      version: deviceVersion(device.version),
      configRevision: configurationRevision(device.configRevision),
      simulated: booleanField(device.simulated, "模拟设备标记"),
    }));
    const documents = collection(state.documents, "资料", normalizeDocument);
    const workOrders = collection(state.workOrders, "工单", normalizeWorkOrder);
    const activity = collection(state.activity, "活动记录", (item) => {
      if (!ACTIVITY_TYPES.includes(item.type)) {
        throw new Error("活动记录类型无效。");
      }
      const event = {
        id: requiredText(item.id, "活动编号"),
        type: item.type,
        entityId: requiredText(item.entityId, "活动关联编号"),
        deviceId: item.deviceId === null ? null : requiredText(item.deviceId, "活动设备编号"),
        createdAt: timestamp(item.createdAt),
        summary: requiredText(item.summary, "活动摘要"),
      };
      if (item.type === "device-version-changed") {
        event.beforeVersion = deviceVersion(item.beforeVersion);
        event.afterVersion = deviceVersion(item.afterVersion);
      }
      return event;
    });

    const deviceIds = new Set(devices.map((device) => device.id));
    const draftIds = new Set(workOrders.map((order) => order.draftId));
    if (workOrders.some((order) => !deviceIds.has(order.deviceId)) || activity.some((item) => item.deviceId !== null && !deviceIds.has(item.deviceId))) {
      throw new Error("工单或活动记录关联到不存在的设备。");
    }
    if (draftIds.size !== workOrders.length) {
      throw new Error("多个工单关联到同一草稿。");
    }
    return { schemaVersion: SCHEMA_VERSION, devices, documents, workOrders, activity };
  }

  return {
    SCHEMA_VERSION,
    DEFAULT_DESCRIPTION,
    createInitialState,
    validateState,
    getApplicability,
    createDraft,
    addDevice,
    updateDeviceVersion,
    addDocument,
    commitDraft,
    recordRetest,
  };
});
