// Event stream feeding the live dashboard. Every event is persisted (so a late viewer can replay
// from seq 0) and fanned out in-process. Swap for Redis Streams/NATS by re-implementing publish/subscribe.
import { EventEmitter } from "node:events";
import type { Db } from "./db.js";

export type SwarmEventType =
  | "study.started" | "study.finished" | "study.cost"
  | "session.status" | "session.step" | "session.signal"
  | "issues.updated" | "report.ready" | "log";

export interface SwarmEvent {
  seq: number;
  studyId: string;
  type: SwarmEventType;
  data: any;
  at: number;
}

export class EventBus {
  private emitter = new EventEmitter();

  constructor(private db: Db) {
    this.emitter.setMaxListeners(1000);
  }

  publish(studyId: string, type: SwarmEventType, data: unknown): void {
    const seq = this.db.appendEvent(studyId, type, data);
    const ev: SwarmEvent = { seq, studyId, type, data, at: Date.now() };
    this.emitter.emit(studyId, ev);
    this.emitter.emit("*", ev);
  }

  subscribe(studyId: string | "*", fn: (ev: SwarmEvent) => void): () => void {
    this.emitter.on(studyId, fn);
    return () => this.emitter.off(studyId, fn);
  }

  replay(studyId: string, afterSeq = 0): SwarmEvent[] {
    return this.db.events(studyId, afterSeq).map((e) => ({ ...e, studyId, type: e.type as SwarmEventType }));
  }
}
