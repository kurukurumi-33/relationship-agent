import type { AppState } from "../domain/types.js";

/**
 * 演示用种子数据。全部是虚构的，但结构按真实接入（聊天导出、日历 API、手工笔记）来设计。
 */
export const seedState: Partial<AppState> = {
  persons: {
    p_001: {
      personId: "p_001",
      name: "张三",
      relation: "前同事 / 项目搭子",
      tags: ["技术", "健身", "有鼻炎"],
      relationshipGoal: "维持项目上的合作关系，健康相关的提醒宁多勿少",
      createdAt: "2026-02-10T09:00:00+08:00",
    },
    p_002: {
      personId: "p_002",
      name: "李四",
      relation: "大学同学",
      tags: ["摄影"],
      createdAt: "2026-02-11T09:00:00+08:00",
    },
  },
  evidence: {
    ev_001: {
      evidenceId: "ev_001",
      personId: "p_001",
      kind: "message",
      capturedAt: "2026-10-26T21:14:00+08:00",
      title: "微信：复查时间",
      content:
        "张三：我 11 月 2 号上午得去医院复查，下午才能回公司。\n我：那评审会要不要挪到下午？\n张三：下午两点后都行，上午真参加不了。",
      sourceRef: "screenshots/wechat-2026-10-26-zhangsan.png",
    },
    ev_002: {
      evidenceId: "ev_002",
      personId: "p_001",
      kind: "calendar",
      capturedAt: "2026-10-20T10:00:00+08:00",
      title: "日历：项目复盘会",
      content: "议题：Q4 项目复盘。原定 11 月 2 日 10:00-11:30，参与人：我、张三、王五。状态：待确认。",
      sourceRef: "calendar://event/evt_88213",
    },
    ev_003: {
      evidenceId: "ev_003",
      personId: "p_001",
      kind: "note",
      capturedAt: "2026-09-15T19:30:00+08:00",
      title: "手记：饭桌上的事",
      content: "张三在戒烟，第三个月了。上次聚餐他明确说别递烟，也别约在能抽烟的馆子。",
      sourceRef: "notes/2026-09-15-dinner.md",
    },
    ev_101: {
      evidenceId: "ev_101",
      personId: "p_002",
      kind: "message",
      capturedAt: "2026-10-01T12:00:00+08:00",
      title: "微信：约拍",
      content: "李四：国庆后找个周末去拍银杏吧，我新买了个 35mm。",
      sourceRef: "screenshots/wechat-2026-10-01-lisi.png",
    },
    // 过期证据：原图过了 24h 就不再对模型可见，只留摘要和来源
    ev_004: {
      evidenceId: "ev_004",
      personId: "p_001",
      kind: "screenshot",
      capturedAt: "2026-10-25T20:00:00+08:00",
      title: "微信截图：出差安排",
      content:
        "【OCR】张三：下周三到周五出差，周六才回来。\n我：那这周别约饭了？\n张三：对，等我回来。",
      sourceRef: "screenshots/wechat-2026-10-25-zhangsan.png",
      contentHash: "sha256:demo-ev-004",
      expiresAt: "2026-10-26T20:00:00+08:00",
      summary: "张三下周三四五出差，周六回。",
    },
  },
  memoryDocs: {
    p_001: {
      personId: "p_001",
      generation: 1,
      version: 1,
      items: [
        {
          memoryId: "mem_seed1",
          text: "张三在戒烟，聚餐不要递烟、不要约能抽烟的馆子。",
          sourceIds: ["ev_003"],
          confirmedAt: "2026-09-15T20:00:00+08:00",
        },
      ],
      updatedAt: "2026-09-15T20:00:00+08:00",
    },
    p_002: {
      personId: "p_002",
      generation: 0,
      version: 0,
      items: [],
      updatedAt: "2026-02-11T09:00:00+08:00",
    },
  },
  candidates: {},
  actions: {},
  idempotency: {},
  sessions: {},
};