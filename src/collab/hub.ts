import { randomUUID } from "node:crypto";
import type {
  BlackboardEntry,
  CollabDispatchInfo,
  CollabDispatchStatus,
  CollabMessage,
  CollabPeerInfo,
  CollabResponseState,
  PeerStatus,
  SendMessageParams,
  SendMessageResult,
  SupervisorMessage,
  SupervisorMessageKind
} from "./types.js";

// Foreground MCP wait only; it never expires the background dispatch.
const DEFAULT_WAIT_WINDOW_SECONDS = 45;
const DISPATCH_HEALTH_CHECK_MS = 15_000;
// Inactivity is surfaced as a suspicion state, never as a task timeout.
const PEER_STALL_MS = 2 * 60 * 1000;
const MAX_HOP_COUNT = 3;
// Heartbeat cleanup is a connection liveness fallback, not an AI thinking deadline.
const PEER_STALE_MS = 5 * 60 * 1000;
const MAX_DISPATCH_HISTORY = 500;

export type CollabAutoResponderResult = string | { reply?: string; error?: string } | undefined;
export type CollabAutoResponder = (msg: CollabMessage) => Promise<CollabAutoResponderResult>;

interface PendingReply {
  messageId: string;
  resolve: (result: SendMessageResult) => void;
  timer: NodeJS.Timeout;
}

export type ReplyMessageStatus = "delivered" | "duplicate_ignored" | "stale_or_expired";

export class CollabHub {
  private peers = new Map<string, CollabPeerInfo>();
  private deliveryQueues = new Map<string, CollabMessage[]>();
  private inboxes = new Map<string, CollabMessage[]>();
  private subscribers = new Map<string, Set<(msg: CollabMessage) => void>>();
  private pendingReplies = new Map<string, PendingReply>();
  private messages = new Map<string, CollabMessage>();
  private handledReplyIds = new Set<string>();
  private blackboard = new Map<string, BlackboardEntry>();
  private supervisorMessages: SupervisorMessage[] = [];
  private dispatches = new Map<string, CollabDispatchInfo>();
  private healthTimer?: NodeJS.Timeout;
  private autoResponder?: CollabAutoResponder;

  public setAutoResponder(responder: CollabAutoResponder): void {
    this.autoResponder = responder;
  }

  private normalizeKey(key: string): string {
    return (key || "default").trim().replace(/\\/g, "/").toLowerCase();
  }

  private profileKey(profile: string): string {
    return `profile:${profile.trim().toLowerCase()}`;
  }

  private peerKey(profile: string, peerId?: string): string {
    return peerId?.trim() || this.profileKey(profile);
  }

  private findPeerEntry(profile: string, peerId?: string): [string, CollabPeerInfo] | undefined {
    if (peerId) {
      const key = this.peerKey(profile, peerId);
      const direct = this.peers.get(key);
      if (!direct || direct.profile.trim().toLowerCase() !== profile.trim().toLowerCase()) return undefined;
      return [key, direct];
    }
    const matches = this.findPeerEntries(profile);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private findPeerEntries(profile: string): Array<[string, CollabPeerInfo]> {
    const profileLower = profile.trim().toLowerCase();
    return [...this.peers.entries()]
      .filter(([, peer]) => peer.profile.trim().toLowerCase() === profileLower)
      .sort((a, b) => b[1].registeredAt - a[1].registeredAt);
  }

  private resolveTarget(profile: string, peerId?: string):
    | { key: string; peerId?: string; error?: undefined }
    | { key?: undefined; peerId?: undefined; error: string } {
    if (peerId) {
      const existing = this.peers.get(peerId);
      if (existing && existing.profile.trim().toLowerCase() !== profile.trim().toLowerCase()) {
        return { error: `CLI instance '${peerId}' does not belong to profile '@${profile}'.` };
      }
      return { key: peerId, peerId };
    }

    const matches = this.findPeerEntries(profile);
    if (matches.length > 1) {
      const ids = matches.map(([, peer]) => peer.peerId).join(", ");
      return {
        error: `Profile '@${profile}' has multiple CLI instances (${ids}). Specify 'peerId' to select one.`
      };
    }
    if (matches.length === 1) return { key: matches[0][0], peerId: matches[0][1].peerId };
    return { key: this.profileKey(profile) };
  }

  private markReplyHandled(replyToId: string): void {
    this.handledReplyIds.add(replyToId);
    if (this.handledReplyIds.size > 2_000) {
      const oldest = this.handledReplyIds.values().next().value;
      if (oldest) this.handledReplyIds.delete(oldest);
    }
  }

  public isSupervisorTarget(profile: string): boolean {
    const normalized = profile.trim().toLowerCase();
    return normalized === "web-ui" || normalized === "supervisor" || normalized === "__supervisor__";
  }

  public registerPeer(info: {
    peerId?: string;
    profile: string;
    projectKey: string;
    projectDir?: string;
    model?: string;
    pid?: number;
    status?: PeerStatus;
    currentFocus?: string;
    activeFiles?: string[];
  }): CollabPeerInfo {
    if (this.isSupervisorTarget(info.profile)) {
      throw new Error("The Web UI supervisor cannot register as a CLI peer.");
    }

    const profile = info.profile.trim();
    const peerId = info.peerId?.trim()
      || (info.pid !== undefined ? `${profile.toLowerCase()}:${info.pid}` : this.profileKey(profile));
    const now = Date.now();

    if (info.pid !== undefined) {
      for (const [existingKey, existingPeer] of this.peers.entries()) {
        if (existingKey !== peerId && existingPeer.pid === info.pid) {
          this.peers.delete(existingKey);
          this.subscribers.delete(existingKey);
          this.markPeerDisconnected(existingKey);
        }
      }
    }

    const existing = this.peers.get(peerId);
    const peer: CollabPeerInfo = {
      peerId,
      profile,
      projectKey: info.projectKey,
      projectDir: info.projectDir ?? existing?.projectDir,
      model: info.model ?? existing?.model,
      pid: info.pid ?? existing?.pid,
      status: info.status ?? existing?.status ?? "idle",
      currentFocus: info.currentFocus ?? existing?.currentFocus,
      activeFiles: info.activeFiles ?? existing?.activeFiles,
      responseState: existing?.responseState,
      activeMessageId: existing?.activeMessageId,
      responseDeadlineAt: existing?.responseDeadlineAt,
      lastResponseAt: existing?.lastResponseAt,
      lastTimeoutAt: existing?.lastTimeoutAt,
      lastActivityAt: existing?.lastActivityAt ?? now,
      lastOutputAt: existing?.lastOutputAt,
      lastHeartbeat: now,
      registeredAt: existing?.registeredAt ?? now
    };
    this.peers.set(peerId, peer);
    this.refreshDispatchHealth(now);
    return { ...peer };
  }

  public unregisterPeer(profile: string, peerId?: string): boolean {
    const targets = peerId
      ? [this.peerKey(profile, peerId)]
      : this.findPeerEntries(profile).map(([key]) => key);
    let removed = false;
    for (const key of targets) {
      this.subscribers.delete(key);
      removed = this.peers.delete(key) || removed;
      this.markPeerDisconnected(key);
    }
    return removed;
  }

  public heartbeat(profile: string, peerId?: string): boolean {
    const peer = this.findPeerEntry(profile, peerId)?.[1];
    if (!peer) return false;
    peer.lastHeartbeat = Date.now();
    return true;
  }

  public recordPeerActivity(peerId: string, kind: "input" | "output" | "tool" = "output"): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    const now = Date.now();
    peer.lastActivityAt = now;
    if (kind === "output") peer.lastOutputAt = now;
    peer.lastHeartbeat = now;

    for (const dispatch of this.dispatches.values()) {
      if (!this.isActiveDispatch(dispatch) || dispatch.deliveryStatus !== "delivered") continue;
      if (!this.dispatchTargetsPeer(dispatch, peerId)) continue;
      dispatch.status = "processing";
      dispatch.lastActivityAt = now;
      dispatch.targetOnline = true;
      dispatch.updatedAt = now;
    }
    this.syncPeerResponseState(peerId);
    return true;
  }

  public updatePeerFocus(params: {
    profile: string;
    projectKey: string;
    peerId?: string;
    currentFocus?: string;
    activeFiles?: string[];
    status?: PeerStatus;
  }): boolean {
    const peer = this.findPeerEntry(params.profile, params.peerId)?.[1];
    if (!peer) return false;
    if (params.currentFocus !== undefined) peer.currentFocus = params.currentFocus;
    if (params.activeFiles !== undefined) peer.activeFiles = params.activeFiles;
    if (params.status !== undefined) peer.status = params.status;
    peer.lastHeartbeat = Date.now();
    return true;
  }

  public listPeers(_options: { projectKey?: string; allProjects?: boolean } = {}): CollabPeerInfo[] {
    const now = Date.now();
    for (const [key, peer] of this.peers.entries()) {
      if (now - peer.lastHeartbeat <= PEER_STALE_MS) continue;
      this.peers.delete(key);
      this.subscribers.delete(key);
      this.markPeerDisconnected(key);
    }
    this.refreshDispatchHealth(now);
    return [...this.peers.values()].map((peer) => ({ ...peer }));
  }

  public hasActiveSubscriber(profile: string, peerId?: string): boolean {
    if (peerId) return (this.subscribers.get(this.peerKey(profile, peerId))?.size ?? 0) > 0;
    return this.findPeerEntries(profile).some(([key]) => (this.subscribers.get(key)?.size ?? 0) > 0);
  }

  public findPeer(profile: string, peerId?: string): CollabPeerInfo | undefined {
    const peer = this.findPeerEntry(profile, peerId)?.[1];
    return peer ? { ...peer } : undefined;
  }

  public subscribe(
    profile: string,
    _projectKey: string,
    callback: (msg: CollabMessage) => void,
    peerId?: string
  ): () => void {
    if (this.isSupervisorTarget(profile)) {
      throw new Error("The Web UI supervisor cannot subscribe as a CLI peer.");
    }

    const matches = this.findPeerEntries(profile);
    if (!peerId && matches.length > 1) {
      throw new Error(`Profile '@${profile}' has multiple CLI instances. Subscribe with an explicit peerId.`);
    }
    const key = peerId?.trim() || matches[0]?.[0] || this.profileKey(profile);
    const previous = this.subscribers.get(key);
    previous?.clear();
    const subs = new Set<(msg: CollabMessage) => void>([callback]);
    this.subscribers.set(key, subs);

    this.flushDeliveryQueue(key, callback);
    const profileQueueKey = this.profileKey(profile);
    if (profileQueueKey !== key && this.findPeerEntries(profile).length === 1) {
      this.flushDeliveryQueue(profileQueueKey, callback, key);
    }
    this.refreshDispatchHealth();

    return () => {
      subs.delete(callback);
      if (subs.size === 0 && this.subscribers.get(key) === subs) {
        this.subscribers.delete(key);
        this.markPeerDisconnected(key);
      }
    };
  }

  public async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const hopCount = (params.hopCount ?? 0) + 1;
    if (hopCount > MAX_HOP_COUNT) {
      return {
        messageId: randomUUID(),
        status: "error",
        error: `Deadlock breaker triggered: maximum call depth (${MAX_HOP_COUNT}) exceeded.`
      };
    }
    if (this.isSupervisorTarget(params.to)) {
      return {
        messageId: randomUUID(),
        status: "error",
        error: "The Web UI supervisor is not a CLI peer. Use notifySupervisor instead."
      };
    }

    const target = this.resolveTarget(params.to, params.toPeerId);
    if (target.error) return { messageId: randomUUID(), status: "error", error: target.error };
    const deliveryKey = target.key as string;

    const messageId = randomUUID();
    const waitWindowSeconds = params.waitForReply
      ? Math.max(0, params.timeoutSeconds ?? DEFAULT_WAIT_WINDOW_SECONDS)
      : undefined;
    const message: CollabMessage = {
      id: messageId,
      from: params.from,
      to: params.to,
      fromPeerId: params.fromPeerId,
      toPeerId: target.peerId,
      projectKey: params.projectKey,
      type: params.type ?? "ask",
      content: params.content,
      context: params.context,
      expectedFormat: params.expectedFormat,
      traceId: params.traceId ?? randomUUID(),
      hopCount,
      createdAt: Date.now(),
      timeoutSeconds: waitWindowSeconds,
      origin: params.origin ?? "agent",
      responsePolicy: params.responsePolicy ?? "peer",
      relayTo: params.relayTo
    };
    this.rememberMessage(message);
    this.createDispatch(message);

    const deliver = (): boolean => {
      const subs = this.subscribers.get(deliveryKey);
      if (subs?.size) {
        this.markDispatchDelivered(message.id, target.peerId);
        for (const subscriber of subs) {
          try {
            subscriber(message);
          } catch {
            // A broken terminal subscriber must not block the collaboration network.
          }
        }
        return true;
      }
      this.pushMessage(this.deliveryQueues, deliveryKey, message);
      this.pushMessage(this.inboxes, deliveryKey, message);
      this.markDispatchPending(message.id);
      return false;
    };

    if (!params.waitForReply) {
      const delivered = deliver();
      if (params.type === "task" && this.autoResponder) this.startAutoResponder(message);
      const dispatch = this.dispatches.get(message.id);
      return {
        messageId: message.id,
        status: delivered ? "delivered" : "queued",
        responseStatus: dispatch?.status,
        deadlineAt: dispatch?.deadlineAt
      };
    }

    const synchronousWaitSeconds = waitWindowSeconds ?? DEFAULT_WAIT_WINDOW_SECONDS;
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pendingReplies.delete(message.id);
        const dispatch = this.dispatches.get(message.id);
        if (dispatch) {
          dispatch.deadlineAt = undefined;
          dispatch.updatedAt = Date.now();
          this.updatePeerResponseState(dispatch);
        }
        resolve({
          messageId: message.id,
          status: "deferred",
          responseStatus: dispatch?.status,
          error: `The synchronous wait window ended after ${synchronousWaitSeconds}s; @${params.to} is still handled in the background.`
        });
      }, synchronousWaitSeconds * 1000);
      timer.unref?.();

      this.pendingReplies.set(message.id, {
        messageId: message.id,
        resolve: (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        timer
      });

      deliver();
      if (this.autoResponder) this.startAutoResponder(message);
    });
  }

  public replyMessage(params: {
    from: string;
    to: string;
    fromPeerId?: string;
    toPeerId?: string;
    replyToId: string;
    projectKey: string;
    result: string;
  }): ReplyMessageStatus {
    if (this.handledReplyIds.has(params.replyToId)) return "duplicate_ignored";
    const dispatch = this.dispatches.get(params.replyToId);
    if (dispatch?.status === "timeout" || dispatch?.status === "error") return "stale_or_expired";

    const original = this.messages.get(params.replyToId);
    if (!original || (original.type !== "ask" && original.type !== "task")) return "stale_or_expired";

    this.markReplyHandled(params.replyToId);
    this.markDispatchCompleted(params.replyToId);
    const pending = this.pendingReplies.get(params.replyToId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingReplies.delete(params.replyToId);
      pending.resolve({
        messageId: params.replyToId,
        status: "replied",
        responseStatus: "completed",
        deadlineAt: this.dispatches.get(params.replyToId)?.deadlineAt,
        reply: params.result
      });
      return "delivered";
    }

    if (original.origin === "supervisor") {
      this.addSupervisorMessage({
        from: params.from,
        fromPeerId: params.fromPeerId ?? original.toPeerId,
        projectKey: original.projectKey,
        kind: "result",
        title: `Agent @${params.from} completed a supervisor task`,
        message: params.result,
        relatedMessageId: params.replyToId
      });
      return "delivered";
    }

    void this.sendMessage({
      from: params.from,
      to: original.from,
      fromPeerId: params.fromPeerId ?? original.toPeerId,
      toPeerId: original.fromPeerId,
      projectKey: original.projectKey,
      type: "event",
      content: params.result,
      waitForReply: false,
      traceId: original.traceId,
      hopCount: original.hopCount
    });
    return "delivered";
  }

  public getInbox(profile: string, peerId?: string, clear = false): CollabMessage[] {
    const keys: string[] = [];
    if (peerId && (this.peers.has(peerId) || this.inboxes.has(peerId))) {
      keys.push(peerId);
    } else {
      const matches = this.findPeerEntries(profile);
      if (matches.length === 1) keys.push(matches[0][0]);
      keys.push(this.profileKey(profile));
    }
    const uniqueKeys = [...new Set(keys)];
    const messages = uniqueKeys.flatMap((key) => this.inboxes.get(key) ?? []);
    if (clear) uniqueKeys.forEach((key) => this.inboxes.set(key, []));
    return messages;
  }

  public setBlackboard(entry: {
    key: string;
    value: string;
    author: string;
    projectKey?: string;
  }): BlackboardEntry {
    const data: BlackboardEntry = {
      key: entry.key,
      value: entry.value,
      author: entry.author,
      updatedAt: Date.now()
    };
    this.blackboard.set(this.normalizeKey(entry.key), data);
    return { ...data };
  }

  public getBlackboard(key: string, _projectKey?: string): BlackboardEntry | undefined {
    const entry = this.blackboard.get(this.normalizeKey(key));
    return entry ? { ...entry } : undefined;
  }

  public listBlackboard(_projectKey?: string): BlackboardEntry[] {
    return [...this.blackboard.values()].map((entry) => ({ ...entry }));
  }

  public notifySupervisor(params: {
    projectKey: string;
    from: string;
    fromPeerId?: string;
    kind?: SupervisorMessageKind;
    title?: string;
    message: string;
    relatedMessageId?: string;
  }): SupervisorMessage {
    const kind = params.kind ?? "message";
    const relatedMessageId = params.relatedMessageId || (["result", "blocked", "error"].includes(kind)
      ? this.findWaitingSupervisorDispatch(params.from, params.fromPeerId)?.id
      : undefined);
    const relatedDispatch = relatedMessageId ? this.dispatches.get(relatedMessageId) : undefined;
    const late = relatedDispatch?.status === "timeout" || relatedDispatch?.status === "error";
    if (relatedMessageId) {
      if (kind === "result") this.markDispatchCompleted(relatedMessageId);
      if (kind === "blocked" || kind === "error") this.markDispatchError(relatedMessageId, params.message);
    }
    return this.addSupervisorMessage({ ...params, kind, relatedMessageId, late });
  }

  private addSupervisorMessage(params: {
    projectKey: string;
    from: string;
    fromPeerId?: string;
    kind: SupervisorMessageKind;
    title?: string;
    message: string;
    relatedMessageId?: string;
    late?: boolean;
  }): SupervisorMessage {
    const entry: SupervisorMessage = {
      id: randomUUID(),
      projectKey: params.projectKey,
      from: params.from,
      fromPeerId: params.fromPeerId,
      kind: params.kind,
      title: (params.title || "来自 Agent 的消息").trim().slice(0, 160),
      message: params.message.trim().slice(0, 30_000),
      relatedMessageId: params.relatedMessageId,
      late: params.late || undefined,
      createdAt: Date.now()
    };
    this.supervisorMessages.unshift(entry);
    if (this.supervisorMessages.length > 200) this.supervisorMessages.length = 200;
    return { ...entry };
  }

  public getDispatch(messageId: string): CollabDispatchInfo | undefined {
    this.refreshDispatchHealth();
    const dispatch = this.dispatches.get(messageId);
    return dispatch ? { ...dispatch } : undefined;
  }

  public listDispatches(options: {
    projectKey?: string;
    allProjects?: boolean;
    limit?: number;
    status?: CollabDispatchStatus;
  } = {}): CollabDispatchInfo[] {
    this.refreshDispatchHealth();
    const limit = Math.min(MAX_DISPATCH_HISTORY, Math.max(1, options.limit ?? 100));
    return [...this.dispatches.values()]
      .filter((dispatch) => !options.status || dispatch.status === options.status)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((dispatch) => ({ ...dispatch }));
  }

  public listSupervisorMessages(options: {
    projectKey?: string;
    allProjects?: boolean;
    unreadOnly?: boolean;
    limit?: number;
  } = {}): SupervisorMessage[] {
    const limit = Math.min(200, Math.max(1, options.limit ?? 100));
    return this.supervisorMessages
      .filter((entry) => !options.unreadOnly || !entry.readAt)
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  public markSupervisorMessagesRead(options: { ids?: string[]; projectKey?: string; all?: boolean }): number {
    const ids = new Set((options.ids ?? []).map((id) => id.trim()).filter(Boolean));
    const now = Date.now();
    let count = 0;
    for (const entry of this.supervisorMessages) {
      if (entry.readAt) continue;
      if (options.all || ids.has(entry.id)) {
        entry.readAt = now;
        count += 1;
      }
    }
    return count;
  }

  public refreshDispatchHealth(now = Date.now()): void {
    for (const dispatch of this.dispatches.values()) {
      if (!this.isActiveDispatch(dispatch) || dispatch.deliveryStatus !== "delivered") continue;
      const online = this.hasActiveSubscriber(dispatch.to, dispatch.toPeerId);
      dispatch.targetOnline = online;
      if (!online) {
        if (dispatch.status !== "disconnected") {
          dispatch.status = "disconnected";
          dispatch.updatedAt = now;
        }
        this.updatePeerResponseState(dispatch);
        continue;
      }

      const targetPeer = dispatch.toPeerId
        ? this.peers.get(dispatch.toPeerId)
        : this.findPeerEntry(dispatch.to)?.[1];
      const activityAt = dispatch.lastActivityAt;
      const baseline = activityAt ?? dispatch.waitingSince ?? dispatch.createdAt;
      const nextStatus: CollabDispatchStatus = targetPeer?.status === "busy"
        ? "processing"
        : now - baseline >= PEER_STALL_MS
        ? "stalled"
        : activityAt
          ? "processing"
          : "waiting";
      if (dispatch.status !== nextStatus) {
        dispatch.status = nextStatus;
        dispatch.updatedAt = now;
      }
      this.updatePeerResponseState(dispatch);
    }
    this.stopHealthTimerIfIdle();
  }

  public clear(): void {
    this.peers.clear();
    this.deliveryQueues.clear();
    this.inboxes.clear();
    this.subscribers.clear();
    for (const pending of this.pendingReplies.values()) clearTimeout(pending.timer);
    this.pendingReplies.clear();
    this.messages.clear();
    this.handledReplyIds.clear();
    this.dispatches.clear();
    this.blackboard.clear();
    this.supervisorMessages = [];
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
  }

  private startAutoResponder(message: CollabMessage): void {
    const delay = this.hasActiveSubscriber(message.to, message.toPeerId) ? 2_000 : 0;
    const timer = setTimeout(async () => {
      try {
        const autoResult = this.normalizeAutoResponderResult(await this.autoResponder?.(message));
        if (autoResult.reply) {
          this.removeQueuedMessage(message.id);
          this.replyMessage({
            from: message.to,
            to: message.from,
            fromPeerId: message.toPeerId,
            toPeerId: message.fromPeerId,
            replyToId: message.id,
            result: autoResult.reply,
            projectKey: message.projectKey
          });
        } else if (autoResult.error) {
          this.removeQueuedMessage(message.id);
          this.markDispatchError(message.id, autoResult.error);
          const wasWaiting = this.pendingReplies.has(message.id);
          this.resolvePendingError(message.id, autoResult.error);
          if (message.origin === "supervisor") {
            this.addSupervisorMessage({
              from: message.to,
              fromPeerId: message.toPeerId,
              projectKey: message.projectKey,
              kind: "error",
              title: `Agent @${message.to} failed`,
              message: autoResult.error,
              relatedMessageId: message.id
            });
          } else if (!wasWaiting) {
            void this.sendMessage({
              from: message.to,
              to: message.from,
              fromPeerId: message.toPeerId,
              toPeerId: message.fromPeerId,
              projectKey: message.projectKey,
              type: "event",
              content: `[Task failed]: ${autoResult.error}`,
              waitForReply: false
            });
          }
        }
      } catch {
        // Auto responders are an optional offline fallback.
      }
    }, delay);
    timer.unref?.();
  }

  private resolvePendingError(messageId: string, error: string): void {
    const pending = this.pendingReplies.get(messageId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingReplies.delete(messageId);
    pending.resolve({ messageId, status: "error", responseStatus: "error", error });
  }

  private rememberMessage(message: CollabMessage): void {
    this.messages.set(message.id, message);
    if (this.messages.size > 2_000) {
      const oldest = this.messages.keys().next().value;
      if (oldest) this.messages.delete(oldest);
    }
  }

  private flushDeliveryQueue(sourceKey: string, callback: (msg: CollabMessage) => void, targetPeerId?: string): void {
    const queue = this.deliveryQueues.get(sourceKey);
    if (!queue?.length) return;
    this.deliveryQueues.set(sourceKey, []);
    for (const message of queue) {
      if (targetPeerId) message.toPeerId = targetPeerId;
      this.markDispatchDelivered(message.id, targetPeerId ?? message.toPeerId);
      callback(message);
    }
  }

  private pushMessage(store: Map<string, CollabMessage[]>, key: string, message: CollabMessage): void {
    let queue = store.get(key);
    if (!queue) {
      queue = [];
      store.set(key, queue);
    }
    queue.push(message);
    if (queue.length > 100) queue.shift();
  }

  private removeQueuedMessage(messageId: string): void {
    for (const store of [this.deliveryQueues, this.inboxes]) {
      for (const [key, queue] of store.entries()) {
        const filtered = queue.filter((message) => message.id !== messageId);
        if (filtered.length !== queue.length) store.set(key, filtered);
      }
    }
  }

  private createDispatch(message: CollabMessage): void {
    if (message.type !== "ask" && message.type !== "task") return;
    const expectsResponse = message.responsePolicy !== "none";
    const now = Date.now();
    this.dispatches.set(message.id, {
      id: message.id,
      projectKey: message.projectKey,
      from: message.from,
      to: message.to,
      fromPeerId: message.fromPeerId,
      toPeerId: message.toPeerId,
      type: message.type,
      origin: message.origin ?? "agent",
      responsePolicy: message.responsePolicy ?? "peer",
      status: "pending",
      deliveryStatus: "queued",
      targetOnline: this.hasActiveSubscriber(message.to, message.toPeerId),
      expectsResponse,
      createdAt: now,
      updatedAt: now,
      deadlineAt: message.timeoutSeconds !== undefined ? now + message.timeoutSeconds * 1000 : undefined,
      relayTo: message.relayTo
    });
    while (this.dispatches.size > MAX_DISPATCH_HISTORY) {
      const oldest = this.dispatches.keys().next().value;
      if (!oldest) break;
      this.dispatches.delete(oldest);
    }
    this.ensureHealthTimer();
  }

  private markDispatchPending(messageId: string): void {
    const dispatch = this.dispatches.get(messageId);
    if (!dispatch) return;
    dispatch.status = dispatch.expectsResponse ? "pending" : "completed";
    dispatch.deliveryStatus = "queued";
    dispatch.targetOnline = false;
    dispatch.updatedAt = Date.now();
    if (!dispatch.expectsResponse) dispatch.completedAt = dispatch.updatedAt;
    this.updatePeerResponseState(dispatch);
  }

  private markDispatchDelivered(messageId: string, toPeerId?: string): void {
    const dispatch = this.dispatches.get(messageId);
    if (!dispatch || dispatch.status === "error" || dispatch.status === "timeout") return;
    const now = Date.now();
    if (toPeerId) dispatch.toPeerId = toPeerId;
    dispatch.deliveryStatus = "delivered";
    dispatch.targetOnline = true;
    dispatch.status = dispatch.expectsResponse ? "waiting" : "completed";
    dispatch.waitingSince = dispatch.expectsResponse ? now : undefined;
    dispatch.completedAt = dispatch.expectsResponse ? undefined : now;
    dispatch.updatedAt = now;
    this.updatePeerResponseState(dispatch);
  }

  private markDispatchCompleted(messageId: string): void {
    const dispatch = this.dispatches.get(messageId);
    if (!dispatch || dispatch.status === "error" || dispatch.status === "timeout") return;
    const now = Date.now();
    dispatch.status = "completed";
    dispatch.completedAt = now;
    dispatch.updatedAt = now;
    dispatch.deadlineAt = undefined;
    dispatch.error = undefined;
    this.updatePeerResponseState(dispatch);
    this.stopHealthTimerIfIdle();
  }

  private markDispatchError(messageId: string, error?: string): void {
    const dispatch = this.dispatches.get(messageId);
    if (!dispatch || dispatch.status === "completed" || dispatch.status === "timeout") return;
    dispatch.status = "error";
    dispatch.error = error || "Collaboration dispatch failed.";
    dispatch.updatedAt = Date.now();
    dispatch.deadlineAt = undefined;
    this.updatePeerResponseState(dispatch);
    this.stopHealthTimerIfIdle();
  }

  private updatePeerResponseState(dispatch: CollabDispatchInfo): void {
    const peerId = dispatch.toPeerId ?? this.findPeerEntry(dispatch.to)?.[0];
    if (peerId) this.syncPeerResponseState(peerId);
  }

  private syncPeerResponseState(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const active = [...this.dispatches.values()]
      .filter((dispatch) => this.isActiveDispatch(dispatch) && this.dispatchTargetsPeer(dispatch, peerId))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (active) {
      peer.responseState = active.status as CollabResponseState;
      peer.activeMessageId = active.id;
      peer.responseDeadlineAt = active.deadlineAt;
      return;
    }

    const completed = [...this.dispatches.values()]
      .filter((dispatch) => dispatch.status === "completed" && this.dispatchTargetsPeer(dispatch, peerId))
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
    peer.responseState = undefined;
    peer.activeMessageId = undefined;
    peer.responseDeadlineAt = undefined;
    if (completed?.completedAt) peer.lastResponseAt = completed.completedAt;
  }

  private dispatchTargetsPeer(dispatch: CollabDispatchInfo, peerId: string): boolean {
    if (dispatch.toPeerId) return dispatch.toPeerId === peerId;
    const peer = this.peers.get(peerId);
    return Boolean(peer && this.findPeerEntries(dispatch.to).length === 1
      && peer.profile.trim().toLowerCase() === dispatch.to.trim().toLowerCase());
  }

  private markPeerDisconnected(peerId: string): void {
    const now = Date.now();
    for (const dispatch of this.dispatches.values()) {
      if (!this.isActiveDispatch(dispatch) || dispatch.deliveryStatus !== "delivered") continue;
      if (!this.dispatchTargetsPeer(dispatch, peerId)) continue;
      dispatch.status = "disconnected";
      dispatch.targetOnline = false;
      dispatch.updatedAt = now;
    }
  }

  private isActiveDispatch(dispatch: CollabDispatchInfo): boolean {
    return dispatch.expectsResponse && !["completed", "timeout", "error"].includes(dispatch.status);
  }

  private findWaitingSupervisorDispatch(profile: string, peerId?: string): CollabDispatchInfo | undefined {
    const normalizedProfile = profile.trim().toLowerCase();
    return [...this.dispatches.values()]
      .filter((dispatch) => dispatch.origin === "supervisor"
        && this.isActiveDispatch(dispatch)
        && dispatch.to.trim().toLowerCase() === normalizedProfile
        && (!peerId || dispatch.toPeerId === peerId))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  private ensureHealthTimer(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => this.refreshDispatchHealth(), DISPATCH_HEALTH_CHECK_MS);
    this.healthTimer.unref?.();
  }

  private stopHealthTimerIfIdle(): void {
    if (!this.healthTimer) return;
    if ([...this.dispatches.values()].some((dispatch) => this.isActiveDispatch(dispatch))) return;
    clearInterval(this.healthTimer);
    this.healthTimer = undefined;
  }

  private normalizeAutoResponderResult(result: CollabAutoResponderResult): { reply?: string; error?: string } {
    if (typeof result === "string") return { reply: result };
    return result ?? {};
  }
}
