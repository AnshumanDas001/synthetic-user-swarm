import type { AgentAction, StepObservation, StepRecord } from "../src/types.js";

let n = 0;
export function step(partial: Partial<StepRecord> & { action?: AgentAction; obs?: Partial<StepObservation> } = {}): StepRecord {
  const idx = partial.idx ?? n++;
  const { obs, ...rest } = partial;
  return {
    id: `stp_${idx}_${Math.random().toString(16).slice(2, 8)}`,
    sessionId: "ses_1",
    idx,
    url: "http://shop.test/bag",
    pagePath: "/bag",
    title: "Bag",
    stateHash: `h${idx}`,
    action: { type: "click", mark: 1 },
    thinkAloud: "",
    expectation: { says: "", check: { type: "none" } },
    confidence: 3,
    frustration: 2,
    target: { mark: 1, selector: "#checkout", name: "Checkout", role: "button", box: { x: 10, y: 10, width: 80, height: 30 } },
    artifacts: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    model: "mock",
    estHumanMs: 1000,
    startedAt: 0,
    endedAt: 0,
    ...rest,
    observation: {
      urlBefore: "http://shop.test/bag",
      urlAfter: "http://shop.test/bag",
      navigated: false,
      domChanged: true,
      networkCalls: 0,
      networkErrors: [],
      consoleErrors: [],
      expectationMet: null,
      dialogOpened: false,
      validationMessages: [],
      wordsSeen: 20,
      layoutShift: 0,
      focusChanged: false,
      focusedAfter: null,
      ...obs,
    },
  };
}
