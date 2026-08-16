export type PeerStatus = "idle" | "busy" | "waiting";
export type CollabResponseState = "pending" | "waiting" | "processing" | "stalled" | "disconnected" | "timeout";

export interface CollabPeerInfo {
  peerId: string;
  profile: string;
  /** Local session metadata only. It is not a collaboration routing scope. */
  projectKey: string;
  projectDir?: string;
  model?: string;
  pid?: number;
  status: PeerStatus;
  currentFocus?: string;
  activeFiles?: string[];
  responseState?: CollabResponseState;
  activeMessageId?: string;
  responseDeadlineAt?: number;
  lastResponseAt?: number;
  lastTimeoutAt?: number;
  lastActivityAt: number;
  lastOutputAt?: number;
  lastHeartbeat: number;
  registeredAt: number;
}

export interface CollabMessage {
  id: string;
  from: string;
  to: string;
  fromPeerId?: string;
  toPeerId?: string;
  projectKey: string;
  type: "ask" | "task" | "reply" | "event";
  content: string;
  context?: string;
  expectedFormat?: string;
  replyToId?: string;
  traceId: string;
  hopCount: number;
  createdAt: number;
  timeoutSeconds?: number;
  origin?: "agent" | "supervisor";
  responsePolicy?: "peer" | "supervisor" | "none";
  relayTo?: string;
}

export interface SendMessageParams {
  from: string;
  to: string;
  fromPeerId?: string;
  toPeerId?: string;
  projectKey: string;
  content: string;
  type?: "ask" | "task" | "event";
  context?: string;
  expectedFormat?: string;
  waitForReply?: boolean;
  timeoutSeconds?: number;
  traceId?: string;
  hopCount?: number;
  origin?: "agent" | "supervisor";
  responsePolicy?: "peer" | "supervisor" | "none";
  relayTo?: string;
}

export interface SendMessageResult {
  messageId: string;
  status: "delivered" | "queued" | "replied" | "deferred" | "timeout" | "error";
  responseStatus?: CollabDispatchStatus;
  deadlineAt?: number;
  reply?: string;
  error?: string;
}

export type CollabDispatchStatus = "pending" | "waiting" | "processing" | "stalled" | "disconnected" | "completed" | "timeout" | "error";

export interface CollabDispatchInfo {
  id: string;
  projectKey: string;
  from: string;
  to: string;
  fromPeerId?: string;
  toPeerId?: string;
  type: "ask" | "task";
  origin: "agent" | "supervisor";
  responsePolicy: "peer" | "supervisor" | "none";
  status: CollabDispatchStatus;
  deliveryStatus: "queued" | "delivered";
  targetOnline: boolean;
  expectsResponse: boolean;
  createdAt: number;
  updatedAt: number;
  waitingSince?: number;
  lastActivityAt?: number;
  deadlineAt?: number;
  completedAt?: number;
  timedOutAt?: number;
  error?: string;
  relayTo?: string;
}

export interface BlackboardEntry {
  key: string;
  value: string;
  author: string;
  projectKey?: string;
  updatedAt: number;
}

export type SupervisorMessageKind = "message" | "status" | "result" | "blocked" | "error";

export interface SupervisorMessage {
  id: string;
  projectKey: string;
  from: string;
  fromPeerId?: string;
  kind: SupervisorMessageKind;
  title: string;
  message: string;
  relatedMessageId?: string;
  late?: boolean;
  createdAt: number;
  readAt?: number;
}
