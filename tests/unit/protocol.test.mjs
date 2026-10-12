import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_ROLES,
  C2S,
  CLIENT_EVENTS,
  HOST_ONLY_EVENTS,
  IDENTITY_FIELDS,
  MAX_NICKNAME_LENGTH,
  MAX_TEXT_LENGTH,
  PUBLIC_DANMAKU_FIELDS,
  REJECT,
  ROLE,
  ROOM,
  S2C,
  SERVER_EVENTS,
  findIdentityLeak,
  hostDanmaku,
  isPlainObject,
  isPlausibleStudentId,
  normalizeClientMessage,
  publicDanmaku,
} from "../../src/shared/protocol.js";

/** 一条内存态弹幕：带齐公共字段和所有身份字段。 */
function fullItem(overrides = {}) {
  return {
    id: "d1",
    text: "没听懂",
    nickname: "匿名同学",
    color: "#7fd1ff",
    presetId: "not_understood",
    ts: 1_700_000_000_000,
    likes: 3,
    deviceId: "dev-abc",
    studentId: "2023010101",
    name: "张三",
    ...overrides,
  };
}

test("协议常量", async (t) => {
  await t.test("角色与房间是冻结的", () => {
    assert.ok(Object.isFrozen(ROLE));
    assert.ok(Object.isFrozen(ROOM));
    assert.deepEqual(ALL_ROLES, ["host", "student", "overlay", "screen"]);
    assert.notEqual(ROOM.PUBLIC, ROOM.HOST);
  });

  await t.test("事件名在两个方向之间不重复", () => {
    // 重复的事件名意味着同一个字符串既可能是入站也可能是出站，
    // 这种歧义会在 handler 里变成"偶尔把服务端消息当成客户端消息处理"
    const all = [...CLIENT_EVENTS, ...SERVER_EVENTS];
    assert.equal(new Set(all).size, all.length);
    // 事件名只有"小写段:驼峰段"这一种形态（rateLimited、host:fetchIdentity）
    for (const name of all) {
      assert.match(name, /^[A-Za-z]+(?::[A-Za-z]+)?$/, `事件名形态异常：${name}`);
    }
  });

  await t.test("每个 host: 前缀的事件都在 HOST_ONLY_EVENTS 里", () => {
    const derived = CLIENT_EVENTS.filter((name) => name.startsWith("host:"));
    assert.deepEqual([...HOST_ONLY_EVENTS].sort(), derived.sort());
    assert.ok(HOST_ONLY_EVENTS.includes(C2S.HOST_FETCH_IDENTITY));
    assert.ok(!HOST_ONLY_EVENTS.includes(C2S.SEND));
    assert.ok(!HOST_ONLY_EVENTS.includes(C2S.LIKE));
  });
});

test("公共弹幕载荷：身份字段一个都不许漏出去", async (t) => {
  await t.test("字段集合与白名单完全一致", () => {
    const payload = publicDanmaku(fullItem());
    // 用集合相等而不是"包含"，这样新增字段也必须显式加进白名单
    assert.deepEqual(Object.keys(payload).sort(), [...PUBLIC_DANMAKU_FIELDS].sort());
    assert.deepEqual(payload, {
      id: "d1",
      text: "没听懂",
      nickname: "匿名同学",
      color: "#7fd1ff",
      presetId: "not_understood",
      ts: 1_700_000_000_000,
    });
  });

  await t.test("设备号、学号、姓名都留在服务器上", () => {
    const payload = publicDanmaku(fullItem());
    assert.deepEqual(findIdentityLeak(payload), []);
    assert.equal(payload.deviceId, undefined);
    assert.equal(payload.studentId, undefined);
    assert.equal(payload.name, undefined);
    assert.equal(payload.likes, undefined);
  });

  await t.test("即使 item 被污染成一个嵌套对象也不会漏", () => {
    const payload = publicDanmaku(fullItem({ presetId: undefined }));
    assert.equal(payload.presetId, null);
    assert.deepEqual(findIdentityLeak(payload), []);
  });

  await t.test("host 载荷只多一个 deviceId", () => {
    const payload = hostDanmaku(fullItem());
    assert.equal(payload.deviceId, "dev-abc");
    assert.equal(payload.studentId, undefined);
    assert.equal(payload.name, undefined);
    // 学号和姓名即使对老师也必须走 host:fetchIdentity 单独请求，不随广播下发
    assert.deepEqual(
      findIdentityLeak(payload),
      ["$.deviceId"],
      "host 载荷里唯一允许出现的身份字段是 deviceId",
    );
  });

  await t.test("findIdentityLeak 能钻进数组和嵌套对象", () => {
    const found = findIdentityLeak({ a: [{ b: { name: "x" } }], deviceId: "y" });
    assert.deepEqual(found.sort(), ["$.a[0].b.name", "$.deviceId"]);
    assert.deepEqual(findIdentityLeak(null), []);
    assert.deepEqual(findIdentityLeak("deviceId"), []);
    assert.deepEqual(findIdentityLeak({}), []);
  });

  await t.test("身份字段清单本身是冻结的", () => {
    assert.ok(Object.isFrozen(IDENTITY_FIELDS));
    assert.deepEqual([...IDENTITY_FIELDS], ["studentId", "name", "deviceId"]);
  });
});

test("normalizeClientMessage：未知事件与非对象载荷", async (t) => {
  await t.test("未知事件被拒", () => {
    const result = normalizeClientMessage("danmaku:explode", {});
    assert.equal(result.ok, false);
    assert.match(result.reason, /未知事件/);
  });

  for (const payload of [null, undefined, "x", 42, [], true]) {
    await t.test(`载荷 ${JSON.stringify(payload) ?? String(payload)} 被拒`, () => {
      const result = normalizeClientMessage(C2S.SEND, payload);
      assert.equal(result.ok, false);
      assert.match(result.reason, /必须是对象/);
    });
  }
});

test("normalizeClientMessage：join", async (t) => {
  await t.test("最小可用载荷", () => {
    const result = normalizeClientMessage(C2S.JOIN, { role: "student", classId: "c1" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      role: "student",
      classId: "c1",
      deviceId: null,
      nickname: null,
      identity: null,
    });
  });

  await t.test("非法角色被拒", () => {
    for (const role of ["teacher", "", null, 42, "HOST"]) {
      const result = normalizeClientMessage(C2S.JOIN, { role, classId: "c1" });
      assert.equal(result.ok, false, `role=${String(role)} 应该被拒`);
    }
  });

  await t.test("空 classId 被拒", () => {
    for (const classId of ["", "   ", null, undefined, 42]) {
      const result = normalizeClientMessage(C2S.JOIN, { role: "student", classId });
      assert.equal(result.ok, false, `classId=${String(classId)} 应该被拒`);
    }
  });

  await t.test("deviceId 可选，但给了就必须合法", () => {
    const ok = normalizeClientMessage(C2S.JOIN, {
      role: "student",
      classId: "c1",
      deviceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.value.deviceId, "0f8fad5b-d9cb-469f-a165-70867728950e");

    // 允许的字符集是 [A-Za-z0-9_.:-]，带空格或斜杠的一律拒
    for (const deviceId of ["has space", "a/b", "<script>", "中文设备"]) {
      const bad = normalizeClientMessage(C2S.JOIN, { role: "student", classId: "c1", deviceId });
      assert.equal(bad.ok, false, `deviceId=${deviceId} 应该被拒`);
    }
  });

  await t.test("昵称去零宽字符并限长", () => {
    const result = normalizeClientMessage(C2S.JOIN, {
      role: "student",
      classId: "c1",
      nickname: "张\u200b三\uFEFF",
    });
    assert.equal(result.value.nickname, "张三");

    const long = normalizeClientMessage(C2S.JOIN, {
      role: "student",
      classId: "c1",
      nickname: "一".repeat(40),
    });
    assert.equal(long.value.nickname.length, MAX_NICKNAME_LENGTH);

    const blank = normalizeClientMessage(C2S.JOIN, {
      role: "student",
      classId: "c1",
      nickname: "\u200b  ",
    });
    assert.equal(blank.value.nickname, null);
  });

  await t.test("identity 缺失或非法时退化成 null，而不是让整个 join 失败", () => {
    // 学生可以先不发身份、直接进来看看 —— 填身份是进教室之后的动作
    for (const identity of [undefined, null, "张三", 42, {}, { studentId: "", name: "" }]) {
      const result = normalizeClientMessage(C2S.JOIN, { role: "student", classId: "c1", identity });
      assert.equal(result.ok, true);
      assert.equal(result.value.identity, null);
    }

    const real = normalizeClientMessage(C2S.JOIN, {
      role: "student",
      classId: "c1",
      identity: { studentId: "2023010101", name: "张三", extra: "丢弃" },
    });
    assert.deepEqual(real.value.identity, { studentId: "2023010101", name: "张三" });
  });
});

test("normalizeClientMessage：danmaku:send", async (t) => {
  await t.test("正常文本", () => {
    const result = normalizeClientMessage(C2S.SEND, { text: "  老师这一步没懂  " });
    assert.equal(result.ok, true);
    assert.equal(result.value.text, "老师这一步没懂");
    assert.equal(result.value.presetId, null);
  });

  await t.test("空文本与纯空白被拒，原因是 empty", () => {
    for (const text of ["", "   ", "\u200b", "\n\t", null, undefined, 42]) {
      const result = normalizeClientMessage(C2S.SEND, { text });
      assert.equal(result.ok, false, `text=${JSON.stringify(text)} 应该被拒`);
      assert.equal(result.reason, REJECT.EMPTY);
    }
  });

  await t.test(`超过 ${MAX_TEXT_LENGTH} 字被拒，原因是 too_long`, () => {
    const result = normalizeClientMessage(C2S.SEND, { text: "字".repeat(MAX_TEXT_LENGTH + 1) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REJECT.TOO_LONG);

    // 极端长度也不能把 cleanString 的截断变成"静默截短后放行"
    const huge = normalizeClientMessage(C2S.SEND, { text: "字".repeat(100_000) });
    assert.equal(huge.ok, false);
    assert.equal(huge.reason, REJECT.TOO_LONG);
  });

  await t.test(`正好 ${MAX_TEXT_LENGTH} 字放行`, () => {
    const result = normalizeClientMessage(C2S.SEND, { text: "字".repeat(MAX_TEXT_LENGTH) });
    assert.equal(result.ok, true);
    assert.equal(result.value.text.length, MAX_TEXT_LENGTH);
  });

  await t.test("presetId 可选且必须合法", () => {
    const ok = normalizeClientMessage(C2S.SEND, { text: "没听懂", presetId: "not_understood" });
    assert.equal(ok.value.presetId, "not_understood");

    const explicitNull = normalizeClientMessage(C2S.SEND, { text: "没听懂", presetId: null });
    assert.equal(explicitNull.value.presetId, null);

    for (const presetId of ["带 空格", "a/b", "中文", "x".repeat(80)]) {
      const bad = normalizeClientMessage(C2S.SEND, { text: "没听懂", presetId });
      assert.equal(bad.ok, false, `presetId=${presetId} 应该被拒`);
    }
  });

  await t.test("tempId 用于本地先回显", () => {
    const result = normalizeClientMessage(C2S.SEND, { text: "在吗", tempId: "tmp-1" });
    assert.equal(result.value.tempId, "tmp-1");
    const missing = normalizeClientMessage(C2S.SEND, { text: "在吗" });
    assert.equal(missing.value.tempId, null);
  });
});

test("normalizeClientMessage：只要一个 id 的事件", async (t) => {
  const events = [C2S.LIKE, C2S.HOST_REMOVE, C2S.HOST_RESOLVED, C2S.HOST_FETCH_IDENTITY];

  for (const event of events) {
    await t.test(`${event} 接受合法 id`, () => {
      const result = normalizeClientMessage(event, { id: "d-1" });
      assert.equal(result.ok, true);
      assert.deepEqual(result.value, { id: "d-1" });
    });

    await t.test(`${event} 拒绝缺失或非法 id`, () => {
      for (const id of [undefined, null, "", "  ", "a b", "a/b", 42, {}]) {
        const result = normalizeClientMessage(event, { id });
        assert.equal(result.ok, false, `id=${JSON.stringify(id)} 应该被拒`);
      }
    });
  }
});

test("normalizeClientMessage：老师指令", async (t) => {
  await t.test("host:pause 只收布尔值", () => {
    assert.deepEqual(normalizeClientMessage(C2S.HOST_PAUSE, { paused: true }).value, {
      paused: true,
    });
    // 不收 0/1/"true"：这三种写法都意味着某处有类型转换，源头该修而不是这里兜
    for (const paused of [0, 1, "true", "false", null, undefined]) {
      assert.equal(
        normalizeClientMessage(C2S.HOST_PAUSE, { paused }).ok,
        false,
        `paused=${JSON.stringify(paused)} 应该被拒`,
      );
    }
  });

  await t.test("host:mute 限 0~120 分钟", () => {
    assert.deepEqual(normalizeClientMessage(C2S.HOST_MUTE, { minutes: 5 }).value, { minutes: 5 });
    assert.equal(normalizeClientMessage(C2S.HOST_MUTE, { minutes: 0 }).ok, true);
    assert.equal(normalizeClientMessage(C2S.HOST_MUTE, { minutes: 120 }).ok, true);

    for (const minutes of [-1, 121, NaN, Infinity, "abc", null, undefined, {}]) {
      assert.equal(
        normalizeClientMessage(C2S.HOST_MUTE, { minutes }).ok,
        false,
        `minutes=${String(minutes)} 应该被拒`,
      );
    }
  });

  await t.test("host:pin 要 id + 布尔值", () => {
    assert.deepEqual(normalizeClientMessage(C2S.HOST_PIN, { id: "d1", pinned: true }).value, {
      id: "d1",
      pinned: true,
    });
    assert.equal(normalizeClientMessage(C2S.HOST_PIN, { id: "d1" }).ok, false);
    assert.equal(normalizeClientMessage(C2S.HOST_PIN, { id: "d1", pinned: "yes" }).ok, false);
  });

  await t.test("host:ban 默认是拉黑，banned:false 才是解禁", () => {
    assert.deepEqual(normalizeClientMessage(C2S.HOST_BAN, { deviceId: "dev-1" }).value, {
      deviceId: "dev-1",
      banned: true,
    });
    assert.deepEqual(normalizeClientMessage(C2S.HOST_BAN, { deviceId: "dev-1", banned: false }).value, {
      deviceId: "dev-1",
      banned: false,
    });
    assert.equal(normalizeClientMessage(C2S.HOST_BAN, {}).ok, false);
  });

  await t.test("host:config 逐值转数字，空对象被拒", () => {
    const result = normalizeClientMessage(C2S.HOST_CONFIG, { duration: "14", fontSize: 30 });
    assert.deepEqual(result.value, { duration: 14, fontSize: 30 });
    assert.equal(normalizeClientMessage(C2S.HOST_CONFIG, {}).ok, false);
    assert.equal(normalizeClientMessage(C2S.HOST_CONFIG, { duration: NaN }).ok, false);
    assert.equal(normalizeClientMessage(C2S.HOST_CONFIG, { duration: "abc" }).ok, false);
    assert.equal(normalizeClientMessage(C2S.HOST_CONFIG, { duration: Infinity }).ok, false);
  });

  await t.test("host:clear 与 host:export 没有载荷", () => {
    assert.deepEqual(normalizeClientMessage(C2S.HOST_CLEAR, {}).value, {});
    assert.deepEqual(normalizeClientMessage(C2S.HOST_EXPORT, {}).value, {});
    // 就算多带了字段也被丢掉，不往下传
    assert.deepEqual(normalizeClientMessage(C2S.HOST_CLEAR, { evil: "x" }).value, {});
  });
});

test("每个客户端事件都能被分派，且永远返回 ok 布尔值", async (t) => {
  for (const event of CLIENT_EVENTS) {
    await t.test(event, () => {
      const result = normalizeClientMessage(event, {});
      assert.equal(typeof result.ok, "boolean");
      if (result.ok) assert.equal(typeof result.value, "object");
      else assert.equal(typeof result.reason, "string");
    });
  }
});

test("isPlainObject", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  for (const value of [null, undefined, [], "x", 0, true, () => {}]) {
    assert.equal(isPlainObject(value), false, `${String(value)} 不该算普通对象`);
  }
});

test("isPlausibleStudentId 故意宽松", () => {
  // 各校学号形态差异极大，只拦明显不是学号的东西
  for (const value of ["2023010101", "2023-0101", "abc12345", "A1b2C3d4"]) {
    assert.equal(isPlausibleStudentId(value), true, `${value} 应该被接受`);
  }
  for (const value of ["", "   ", "123", "带中文的学号", "has space", "a".repeat(25), null, 42, {}]) {
    assert.equal(isPlausibleStudentId(value), false, `${JSON.stringify(value)} 应该被拒`);
  }
});
