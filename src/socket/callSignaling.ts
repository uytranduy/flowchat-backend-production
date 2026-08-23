import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { Server, Socket } from "socket.io";
import Conversation from "../models/Conversation.js";
import Friend from "../models/Friend.js";
import Message, {
  type CallMediaType,
  type ICallParticipant,
} from "../models/Message.js";
import User from "../models/User.js";
import {
  emitNewMessage,
  getLastMessageSnapshot,
  updateConversationAfterCreateMessage,
} from "../utils/messageHelper.js";
import {
  blockedInteractionMessage,
  getUserBlockStatus,
} from "../utils/userBlockHelper.js";

const CALL_TIMEOUT_MS = 30_000;
const MAX_GROUP_CALL_PARTICIPANTS = 8;
const CALL_HISTORY_RETRY_DELAYS_MS = [250, 1_000] as const;
const MAX_SDP_LENGTH = 256_000;
const MAX_ICE_CANDIDATE_LENGTH = 32_000;
const MAX_SDP_MID_LENGTH = 256;
const REJECT_REASONS = new Set(["declined", "busy", "media-error"]);
const END_REASONS = new Set([
  "ended",
  "connection-failed",
  "unavailable",
  "media-error",
]);
const GROUP_LEAVE_REASONS = new Set([
  "left",
  "connection-failed",
  "media-error",
]);
const GROUP_END_REASONS = new Set([
  "ended",
  "connection-failed",
  "media-error",
]);

function waitBeforeCallHistoryRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function callDurationSeconds(startedAt: Date, endedAt: Date): number {
  const elapsedMilliseconds = Math.max(
    0,
    endedAt.getTime() - startedAt.getTime()
  );

  // A call that was started and immediately ended is still a real call
  // session. Rounding up prevents its persisted history from misleadingly
  // showing 0 seconds simply because it lasted less than one full second.
  return Math.max(1, Math.ceil(elapsedMilliseconds / 1_000));
}

type Ack = (response: CallAck) => void;
type GroupAck = (response: GroupCallAck) => void;

type CallAck =
  | {
      ok: true;
      callId?: string;
      createdAt?: string;
      timeoutMs?: number;
      mediaType?: CallMediaType;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

type GroupCallAck =
  | ({
      ok: true;
    } & Record<string, unknown>)
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        callId?: string;
      };
    };

type SessionStatus = "ringing" | "active";

type Session = {
  callId: string;
  conversationId: string;
  callerUserId: string;
  callerSocketId: string;
  calleeUserId: string;
  calleeSocketIds: Set<string>;
  acceptedCalleeSocketId?: string;
  status: SessionStatus;
  mediaType: CallMediaType;
  startedAt: Date;
  acceptedAt?: Date;
  timeout: NodeJS.Timeout;
};

type FinishedCall = {
  callId: string;
  conversationId: string;
  mediaType: CallMediaType;
  callerUserId: string;
  calleeUserId: string;
  reason: string;
  durationSeconds: number;
  startedAt: Date;
  acceptedAt?: Date;
  endedAt: Date;
};

type GroupCallParticipant = {
  userId: string;
  socketId: string;
  displayName: string;
  avatarUrl?: string;
  joinedAt: Date;
};

type GroupCallParticipantHistory = {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  firstJoinedAt: Date;
  lastLeftAt?: Date;
  durationMilliseconds: number;
  joinCount: number;
};

type GroupSession = {
  callId: string;
  conversationId: string;
  groupName: string;
  callerUserId: string;
  mediaType: CallMediaType;
  eligibleUserIds: Set<string>;
  participants: Map<string, GroupCallParticipant>;
  participantHistory: Map<string, GroupCallParticipantHistory>;
  status: SessionStatus;
  startedAt: Date;
  acceptedAt?: Date;
  timeout?: NodeJS.Timeout;
};

type FinishedGroupParticipant = {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  joinedAt: Date;
  leftAt: Date;
  durationSeconds: number;
  joinCount: number;
};

type FinishedGroupCall = {
  callId: string;
  conversationId: string;
  mediaType: CallMediaType;
  callerUserId: string;
  reason: string;
  durationSeconds: number;
  startedAt: Date;
  acceptedAt?: Date;
  endedAt: Date;
  participants: FinishedGroupParticipant[];
};

type SessionSignal =
  | {
      type: "offer" | "answer";
      sdp: string;
    }
  | {
      type: "ice-candidate";
      candidate: string;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
    };

type OnlineUsers = Map<string, Set<string>>;

type StartPayload = {
  calleeId: string;
  conversationId: string;
  mediaType: CallMediaType;
};

type GroupStartPayload = {
  conversationId: string;
  mediaType: CallMediaType;
};

type ConversationIdPayload = {
  conversationId: string;
};

type CallIdPayload = {
  callId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedObjectId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) {
    return null;
  }

  return new Types.ObjectId(value).toString();
}

function parseStartPayload(payload: unknown): StartPayload | null {
  if (!isRecord(payload)) return null;

  const calleeId = normalizedObjectId(payload.calleeId);
  const conversationId = normalizedObjectId(payload.conversationId);
  const mediaType = payload.mediaType ?? "audio";

  if (
    !calleeId ||
    !conversationId ||
    (mediaType !== "audio" && mediaType !== "video")
  ) {
    return null;
  }
  return { calleeId, conversationId, mediaType };
}

function parseGroupStartPayload(payload: unknown): GroupStartPayload | null {
  if (!isRecord(payload)) return null;

  const conversationId = normalizedObjectId(payload.conversationId);
  const mediaType = payload.mediaType ?? "audio";
  if (
    !conversationId ||
    (mediaType !== "audio" && mediaType !== "video")
  ) {
    return null;
  }

  return { conversationId, mediaType };
}

function parseConversationIdPayload(
  payload: unknown
): ConversationIdPayload | null {
  if (!isRecord(payload)) return null;
  const conversationId = normalizedObjectId(payload.conversationId);
  return conversationId ? { conversationId } : null;
}

function parseCallIdPayload(payload: unknown): CallIdPayload | null {
  if (!isRecord(payload)) return null;
  const callId = payload.callId;

  if (
    typeof callId !== "string" ||
    callId.length > 64 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      callId
    )
  ) {
    return null;
  }

  return { callId };
}

function parseSignal(signal: unknown): SessionSignal | null {
  if (!isRecord(signal) || typeof signal.type !== "string") return null;

  if (signal.type === "offer" || signal.type === "answer") {
    if (
      typeof signal.sdp !== "string" ||
      signal.sdp.length === 0 ||
      signal.sdp.length > MAX_SDP_LENGTH
    ) {
      return null;
    }

    return { type: signal.type, sdp: signal.sdp };
  }

  if (signal.type !== "ice-candidate") return null;
  if (
    typeof signal.candidate !== "string" ||
    signal.candidate.length > MAX_ICE_CANDIDATE_LENGTH
  ) {
    return null;
  }

  const sdpMid = signal.sdpMid;
  if (
    sdpMid !== undefined &&
    sdpMid !== null &&
    (typeof sdpMid !== "string" || sdpMid.length > MAX_SDP_MID_LENGTH)
  ) {
    return null;
  }

  const sdpMLineIndex = signal.sdpMLineIndex;
  if (
    sdpMLineIndex !== undefined &&
    sdpMLineIndex !== null &&
    (typeof sdpMLineIndex !== "number" ||
      !Number.isInteger(sdpMLineIndex) ||
      sdpMLineIndex < 0 ||
      sdpMLineIndex > 65_535)
  ) {
    return null;
  }

  return {
    type: "ice-candidate",
    candidate: signal.candidate,
    ...(sdpMid !== undefined ? { sdpMid: sdpMid as string | null } : {}),
    ...(sdpMLineIndex !== undefined
      ? { sdpMLineIndex: sdpMLineIndex as number | null }
      : {}),
  };
}

function optionalAck(value: unknown): Ack | undefined {
  return typeof value === "function" ? (value as Ack) : undefined;
}

function optionalGroupAck(value: unknown): GroupAck | undefined {
  return typeof value === "function" ? (value as GroupAck) : undefined;
}

function acknowledge(ack: Ack | undefined, response: CallAck): void {
  if (ack) ack(response);
}

function acknowledgeError(
  ack: Ack | undefined,
  code: string,
  message: string
): void {
  acknowledge(ack, { ok: false, error: { code, message } });
}

function acknowledgeGroup(
  ack: GroupAck | undefined,
  response: GroupCallAck
): void {
  if (ack) ack(response);
}

function acknowledgeGroupError(
  ack: GroupAck | undefined,
  code: string,
  message: string,
  callId?: string
): void {
  acknowledgeGroup(ack, {
    ok: false,
    error: {
      code,
      message,
      ...(callId ? { callId } : {}),
    },
  });
}

function socketUserId(socket: Socket): string | null {
  return socket.user?._id?.toString() ?? null;
}

export class CallSignaling {
  private readonly calls = new Map<string, Session>();
  private readonly groupCalls = new Map<string, GroupSession>();
  private readonly groupCallByConversation = new Map<string, string>();
  private readonly busyUsers = new Map<string, string>();

  constructor(
    private readonly io: Server,
    private readonly onlineUsers: OnlineUsers
  ) {}

  registerSocket(socket: Socket): void {
    socket.on("call:start", (payload: unknown, ackValue?: unknown) => {
      void this.startCall(socket, payload, optionalAck(ackValue));
    });

    socket.on("call:accept", (payload: unknown, ackValue?: unknown) => {
      this.acceptCall(socket, payload, optionalAck(ackValue));
    });

    socket.on("call:reject", (payload: unknown, ackValue?: unknown) => {
      this.rejectCall(socket, payload, optionalAck(ackValue));
    });

    socket.on("call:cancel", (payload: unknown, ackValue?: unknown) => {
      this.cancelCall(socket, payload, optionalAck(ackValue));
    });

    socket.on("call:end", (payload: unknown, ackValue?: unknown) => {
      this.endActiveCall(socket, payload, optionalAck(ackValue));
    });

    socket.on("call:signal", (payload: unknown, ackValue?: unknown) => {
      this.relaySignal(socket, payload, optionalAck(ackValue));
    });

    socket.on("group-call:start", (payload: unknown, ackValue?: unknown) => {
      void this.startGroupCall(socket, payload, optionalGroupAck(ackValue));
    });

    socket.on(
      "group-call:get-active",
      (payload: unknown, ackValue?: unknown) => {
        void this.getActiveGroupCall(
          socket,
          payload,
          optionalGroupAck(ackValue)
        );
      }
    );

    socket.on("group-call:join", (payload: unknown, ackValue?: unknown) => {
      this.joinGroupCall(socket, payload, optionalGroupAck(ackValue));
    });

    socket.on("group-call:leave", (payload: unknown, ackValue?: unknown) => {
      this.leaveGroupCall(socket, payload, optionalGroupAck(ackValue));
    });

    socket.on("group-call:end", (payload: unknown, ackValue?: unknown) => {
      this.endGroupCall(socket, payload, optionalGroupAck(ackValue));
    });

    socket.on("group-call:signal", (payload: unknown, ackValue?: unknown) => {
      this.relayGroupSignal(socket, payload, optionalGroupAck(ackValue));
    });
  }

  handleDisconnect(socket: Socket): void {
    const userId = socketUserId(socket);
    if (!userId) return;

    for (const session of Array.from(this.calls.values())) {
      if (session.status === "ringing") {
        if (session.callerSocketId === socket.id) {
          this.finishCall(session, "disconnected");
          continue;
        }

        if (session.calleeUserId === userId) {
          session.calleeSocketIds.delete(socket.id);
          const hasConnectedCalleeSocket = Array.from(
            session.calleeSocketIds
          ).some((socketId) => this.io.sockets.sockets.has(socketId));

          if (!hasConnectedCalleeSocket) {
            this.finishCall(session, "disconnected");
          }
        }
        continue;
      }

      if (session.callerSocketId === socket.id) {
        this.finishCall(session, "disconnected");
      } else if (session.acceptedCalleeSocketId === socket.id) {
        this.finishCall(session, "disconnected");
      }
    }

    for (const session of Array.from(this.groupCalls.values())) {
      const participant = session.participants.get(userId);
      if (participant?.socketId === socket.id) {
        this.removeGroupParticipant(session, socket, "disconnected");
      }
    }
  }

  private async startGroupCall(
    socket: Socket,
    rawPayload: unknown,
    ack: GroupAck | undefined
  ): Promise<void> {
    try {
      const payload = parseGroupStartPayload(rawPayload);
      if (!payload) {
        acknowledgeGroupError(
          ack,
          "INVALID_PAYLOAD",
          "Dữ liệu cuộc gọi nhóm không hợp lệ"
        );
        return;
      }

      const callerUserId = socketUserId(socket);
      if (!callerUserId) {
        acknowledgeGroupError(
          ack,
          "UNAUTHORIZED",
          "Không thể xác định người gọi"
        );
        return;
      }

      if (this.busyUsers.has(callerUserId)) {
        acknowledgeGroupError(
          ack,
          "CALLER_BUSY",
          "Bạn đang ở trong một cuộc gọi khác"
        );
        return;
      }

      const existingCallId = this.groupCallByConversation.get(
        payload.conversationId
      );
      if (existingCallId && this.groupCalls.has(existingCallId)) {
        acknowledgeGroupError(
          ack,
          "GROUP_CALL_EXISTS",
          "Nhóm đang có một cuộc gọi khác",
          existingCallId
        );
        return;
      }

      const conversation = await Conversation.findById(payload.conversationId)
        .select("type group.name group.dissolvedAt participants.userId")
        .lean();
      const participantIds = Array.from(
        new Set(
          conversation?.participants.map((participant) =>
            participant.userId.toString()
          ) ?? []
        )
      );

      if (
        !conversation ||
        conversation.type !== "group" ||
        Boolean(conversation.group?.dissolvedAt) ||
        participantIds.length < 2 ||
        !participantIds.includes(callerUserId)
      ) {
        acknowledgeGroupError(
          ack,
          "CALL_NOT_ALLOWED",
          "Bạn không có quyền gọi trong nhóm này"
        );
        return;
      }

      if (
        !socket.connected ||
        !this.onlineUsers.get(callerUserId)?.has(socket.id)
      ) {
        acknowledgeGroupError(
          ack,
          "UNAUTHORIZED",
          "Kết nối người gọi đã đóng"
        );
        return;
      }

      if (this.busyUsers.has(callerUserId)) {
        acknowledgeGroupError(
          ack,
          "CALLER_BUSY",
          "Bạn đang ở trong một cuộc gọi khác"
        );
        return;
      }

      const concurrentCallId = this.groupCallByConversation.get(
        payload.conversationId
      );
      if (concurrentCallId && this.groupCalls.has(concurrentCallId)) {
        acknowledgeGroupError(
          ack,
          "GROUP_CALL_EXISTS",
          "Nhóm đang có một cuộc gọi khác",
          concurrentCallId
        );
        return;
      }

      const callId = randomUUID();
      const startedAt = new Date();
      const callerParticipant = this.groupParticipantFromSocket(
        socket,
        startedAt
      );
      if (!callerParticipant) {
        acknowledgeGroupError(
          ack,
          "UNAUTHORIZED",
          "Không thể đọc hồ sơ người gọi"
        );
        return;
      }

      const callerHistory: GroupCallParticipantHistory = {
        userId: callerUserId,
        displayName: callerParticipant.displayName,
        ...(callerParticipant.avatarUrl
          ? { avatarUrl: callerParticipant.avatarUrl }
          : {}),
        firstJoinedAt: startedAt,
        durationMilliseconds: 0,
        joinCount: 1,
      };
      const session: GroupSession = {
        callId,
        conversationId: payload.conversationId,
        groupName: conversation.group?.name?.trim() || "Nhóm chat",
        callerUserId,
        mediaType: payload.mediaType,
        eligibleUserIds: new Set(participantIds),
        participants: new Map([[callerUserId, callerParticipant]]),
        participantHistory: new Map([[callerUserId, callerHistory]]),
        status: "ringing",
        startedAt,
      };

      this.groupCalls.set(callId, session);
      this.groupCallByConversation.set(payload.conversationId, callId);
      this.busyUsers.set(callerUserId, callId);

      const onlineInviteeIds = participantIds.filter(
        (userId) =>
          userId !== callerUserId &&
          Array.from(this.onlineUsers.get(userId) ?? []).some((socketId) =>
            this.io.sockets.sockets.has(socketId)
          )
      );
      const busyUserIds = onlineInviteeIds.filter((userId) =>
        this.busyUsers.has(userId)
      );
      const createdAt = startedAt.toISOString();

      acknowledgeGroup(ack, {
        ok: true,
        callId,
        conversationId: session.conversationId,
        mediaType: session.mediaType,
        createdAt,
        timeoutMs: CALL_TIMEOUT_MS,
        maxParticipants: MAX_GROUP_CALL_PARTICIPANTS,
        invitedUserIds: onlineInviteeIds,
        busyUserIds,
        participants: this.serializeGroupParticipants(session),
      });

      for (const inviteeId of onlineInviteeIds) {
        this.io.to(inviteeId).emit("group-call:incoming", {
          callId,
          conversationId: session.conversationId,
          conversation: {
            id: session.conversationId,
            name: session.groupName,
          },
          caller: {
            id: callerUserId,
            displayName: callerParticipant.displayName,
            avatarUrl: callerParticipant.avatarUrl ?? null,
          },
          mediaType: session.mediaType,
          createdAt,
          timeoutMs: CALL_TIMEOUT_MS,
          maxParticipants: MAX_GROUP_CALL_PARTICIPANTS,
          canJoin: !this.busyUsers.has(inviteeId),
          participantCount: 1,
        });
      }
    } catch (error) {
      console.error("Lỗi khi bắt đầu cuộc gọi nhóm", error);
      acknowledgeGroupError(
        ack,
        "INTERNAL_ERROR",
        "Không thể bắt đầu cuộc gọi nhóm"
      );
    }
  }

  private async getActiveGroupCall(
    socket: Socket,
    rawPayload: unknown,
    ack: GroupAck | undefined
  ): Promise<void> {
    try {
      const payload = parseConversationIdPayload(rawPayload);
      const userId = socketUserId(socket);
      if (!payload || !userId) {
        acknowledgeGroupError(
          ack,
          "INVALID_PAYLOAD",
          "Mã cuộc trò chuyện không hợp lệ"
        );
        return;
      }

      const conversation = await Conversation.findById(payload.conversationId)
        .select("type group.dissolvedAt participants.userId")
        .lean();
      const isMember = Boolean(
        conversation?.participants.some(
          (participant) => participant.userId.toString() === userId
        )
      );
      if (
        !conversation ||
        conversation.type !== "group" ||
        Boolean(conversation.group?.dissolvedAt) ||
        !isMember
      ) {
        acknowledgeGroupError(
          ack,
          "FORBIDDEN",
          "Bạn không có quyền xem cuộc gọi của nhóm này"
        );
        return;
      }

      const callId = this.groupCallByConversation.get(payload.conversationId);
      const session = callId ? this.groupCalls.get(callId) : undefined;
      if (!session) {
        if (callId) this.groupCallByConversation.delete(payload.conversationId);
        acknowledgeGroup(ack, { ok: true, active: false });
        return;
      }

      acknowledgeGroup(ack, {
        ok: true,
        active: true,
        call: this.serializeGroupSession(session),
      });
    } catch (error) {
      console.error("Lỗi khi tìm cuộc gọi nhóm", error);
      acknowledgeGroupError(
        ack,
        "INTERNAL_ERROR",
        "Không thể tìm cuộc gọi nhóm"
      );
    }
  }

  private joinGroupCall(
    socket: Socket,
    rawPayload: unknown,
    ack: GroupAck | undefined
  ): void {
    const session = this.getGroupSession(rawPayload, ack);
    if (!session) return;

    const userId = socketUserId(socket);
    if (!userId || !session.eligibleUserIds.has(userId)) {
      acknowledgeGroupError(
        ack,
        "FORBIDDEN",
        "Bạn không phải thành viên của nhóm này"
      );
      return;
    }

    if (
      !socket.connected ||
      !this.onlineUsers.get(userId)?.has(socket.id)
    ) {
      acknowledgeGroupError(
        ack,
        "UNAUTHORIZED",
        "Kết nối của bạn đã đóng"
      );
      return;
    }

    const existingParticipant = session.participants.get(userId);
    if (existingParticipant) {
      if (existingParticipant.socketId !== socket.id) {
        acknowledgeGroupError(
          ack,
          "ALREADY_JOINED",
          "Tài khoản này đã tham gia trên thiết bị khác"
        );
        return;
      }

      acknowledgeGroup(ack, {
        ok: true,
        ...this.serializeGroupSession(session),
        alreadyJoined: true,
      });
      return;
    }

    const busyCallId = this.busyUsers.get(userId);
    if (busyCallId && busyCallId !== session.callId) {
      acknowledgeGroupError(
        ack,
        "USER_BUSY",
        "Bạn đang ở trong một cuộc gọi khác"
      );
      return;
    }

    if (session.participants.size >= MAX_GROUP_CALL_PARTICIPANTS) {
      acknowledgeGroupError(
        ack,
        "ROOM_FULL",
        `Cuộc gọi nhóm chỉ hỗ trợ tối đa ${MAX_GROUP_CALL_PARTICIPANTS} người`
      );
      return;
    }

    const joinedAt = new Date();
    const participant = this.groupParticipantFromSocket(socket, joinedAt);
    if (!participant) {
      acknowledgeGroupError(
        ack,
        "UNAUTHORIZED",
        "Không thể đọc hồ sơ người tham gia"
      );
      return;
    }

    const existingPeerSocketIds = Array.from(session.participants.values()).map(
      (peer) => peer.socketId
    );
    session.participants.set(userId, participant);
    this.busyUsers.set(userId, session.callId);

    const history = session.participantHistory.get(userId);
    if (history) {
      history.displayName = participant.displayName;
      history.avatarUrl = participant.avatarUrl;
      history.joinCount += 1;
      history.lastLeftAt = undefined;
    } else {
      session.participantHistory.set(userId, {
        userId,
        displayName: participant.displayName,
        ...(participant.avatarUrl ? { avatarUrl: participant.avatarUrl } : {}),
        firstJoinedAt: joinedAt,
        durationMilliseconds: 0,
        joinCount: 1,
      });
    }

    const becameActive = session.status === "ringing";
    if (becameActive) {
      session.status = "active";
      session.acceptedAt = joinedAt;
      if (session.timeout) {
        clearTimeout(session.timeout);
        session.timeout = undefined;
      }
    }

    acknowledgeGroup(ack, {
      ok: true,
      ...this.serializeGroupSession(session),
      alreadyJoined: false,
    });

    if (existingPeerSocketIds.length > 0) {
      this.io.to(existingPeerSocketIds).emit("group-call:participant-joined", {
        callId: session.callId,
        conversationId: session.conversationId,
        participant: this.serializeGroupParticipant(session, participant),
        participantCount: session.participants.size,
      });
    }

    if (becameActive) {
      this.emitToEligibleGroupUsers(session, "group-call:active", {
        callId: session.callId,
        conversationId: session.conversationId,
        mediaType: session.mediaType,
        acceptedAt: joinedAt.toISOString(),
        participantCount: session.participants.size,
      });
    }

    const otherDeviceSocketIds = Array.from(
      this.onlineUsers.get(userId) ?? []
    ).filter((socketId) => socketId !== socket.id);
    if (otherDeviceSocketIds.length > 0) {
      this.io.to(otherDeviceSocketIds).emit("group-call:dismissed", {
        callId: session.callId,
        conversationId: session.conversationId,
        reason: "joined-elsewhere",
      });
    }
  }

  private leaveGroupCall(
    socket: Socket,
    rawPayload: unknown,
    ack: GroupAck | undefined
  ): void {
    const session = this.getGroupSession(rawPayload, ack);
    if (!session) return;

    let reason = "left";
    if (isRecord(rawPayload) && rawPayload.reason !== undefined) {
      if (
        typeof rawPayload.reason !== "string" ||
        !GROUP_LEAVE_REASONS.has(rawPayload.reason)
      ) {
        acknowledgeGroupError(
          ack,
          "INVALID_PAYLOAD",
          "Lý do rời cuộc gọi không hợp lệ"
        );
        return;
      }
      reason = rawPayload.reason;
    }

    const userId = socketUserId(socket);
    const participant = userId ? session.participants.get(userId) : undefined;
    if (!userId || participant?.socketId !== socket.id) {
      acknowledgeGroupError(
        ack,
        "FORBIDDEN",
        "Thiết bị này chưa tham gia cuộc gọi"
      );
      return;
    }

    acknowledgeGroup(ack, { ok: true });
    this.removeGroupParticipant(session, socket, reason);
  }

  private endGroupCall(
    socket: Socket,
    rawPayload: unknown,
    ack: GroupAck | undefined
  ): void {
    const session = this.getGroupSession(rawPayload, ack);
    if (!session) return;

    const userId = socketUserId(socket);
    const participant = userId ? session.participants.get(userId) : undefined;
    if (!userId || participant?.socketId !== socket.id) {
      acknowledgeGroupError(
        ack,
        "FORBIDDEN",
        "Thiết bị này chưa tham gia cuộc gọi"
      );
      return;
    }

    let reason = "ended";
    if (isRecord(rawPayload) && rawPayload.reason !== undefined) {
      if (
        typeof rawPayload.reason !== "string" ||
        !GROUP_END_REASONS.has(rawPayload.reason)
      ) {
        acknowledgeGroupError(
          ack,
          "INVALID_PAYLOAD",
          "Lý do kết thúc cuộc gọi không hợp lệ"
        );
        return;
      }
      reason = rawPayload.reason;
    }

    // Không thành viên nào được kết thúc phòng của những người khác. Event cũ
    // được giữ để tương thích client cũ, nhưng chỉ làm người gửi rời phòng.
    // Phòng thực sự kết thúc trong removeGroupParticipantById khi còn 0 người.
    acknowledgeGroup(ack, { ok: true });
    this.removeGroupParticipant(session, socket, reason);
  }

  private relayGroupSignal(
    socket: Socket,
    rawPayload: unknown,
    ack: GroupAck | undefined
  ): void {
    const session = this.getGroupSession(rawPayload, ack);
    if (!session) return;

    if (!isRecord(rawPayload)) {
      acknowledgeGroupError(
        ack,
        "INVALID_PAYLOAD",
        "Tín hiệu cuộc gọi nhóm không hợp lệ"
      );
      return;
    }

    const senderUserId = socketUserId(socket);
    const sender = senderUserId
      ? session.participants.get(senderUserId)
      : undefined;
    if (!senderUserId || sender?.socketId !== socket.id) {
      acknowledgeGroupError(
        ack,
        "FORBIDDEN",
        "Thiết bị này chưa tham gia cuộc gọi"
      );
      return;
    }

    const signal = parseSignal(rawPayload.signal);
    if (!signal) {
      acknowledgeGroupError(
        ack,
        "INVALID_SIGNAL",
        "Tín hiệu WebRTC không hợp lệ"
      );
      return;
    }

    const rawTargetSocketId = rawPayload.targetSocketId;
    const rawTargetUserId = rawPayload.targetUserId;
    const targetSocketId =
      typeof rawTargetSocketId === "string" &&
      rawTargetSocketId.length > 0 &&
      rawTargetSocketId.length <= 256
        ? rawTargetSocketId
        : null;
    const targetUserId =
      rawTargetUserId === undefined
        ? null
        : normalizedObjectId(rawTargetUserId);

    if (
      (!targetSocketId && !targetUserId) ||
      (rawTargetSocketId !== undefined && !targetSocketId) ||
      (rawTargetUserId !== undefined && !targetUserId)
    ) {
      acknowledgeGroupError(
        ack,
        "INVALID_TARGET",
        "Thiết bị nhận tín hiệu không hợp lệ"
      );
      return;
    }

    let target: GroupCallParticipant | undefined;
    if (targetUserId) {
      target = session.participants.get(targetUserId);
    }
    if (targetSocketId) {
      const socketTarget = Array.from(session.participants.values()).find(
        (participant) => participant.socketId === targetSocketId
      );
      if (target && socketTarget !== target) {
        target = undefined;
      } else {
        target = socketTarget;
      }
    }

    if (!target || target.socketId === socket.id) {
      acknowledgeGroupError(
        ack,
        "PEER_UNAVAILABLE",
        "Người nhận không còn trong cuộc gọi"
      );
      return;
    }

    if (!this.io.sockets.sockets.has(target.socketId)) {
      this.removeGroupParticipantById(
        session,
        target.userId,
        target.socketId,
        "disconnected"
      );
      acknowledgeGroupError(
        ack,
        "PEER_UNAVAILABLE",
        "Thiết bị nhận đã mất kết nối"
      );
      return;
    }

    this.io.to(target.socketId).emit("group-call:signal", {
      callId: session.callId,
      conversationId: session.conversationId,
      fromUserId: senderUserId,
      fromSocketId: socket.id,
      signal,
    });
    acknowledgeGroup(ack, { ok: true });
  }

  private getGroupSession(
    rawPayload: unknown,
    ack: GroupAck | undefined
  ): GroupSession | null {
    const payload = parseCallIdPayload(rawPayload);
    if (!payload) {
      acknowledgeGroupError(ack, "INVALID_PAYLOAD", "Mã cuộc gọi không hợp lệ");
      return null;
    }

    const session = this.groupCalls.get(payload.callId);
    if (!session) {
      acknowledgeGroupError(ack, "STALE_CALL", "Cuộc gọi không còn tồn tại");
      return null;
    }

    return session;
  }

  private groupParticipantFromSocket(
    socket: Socket,
    joinedAt: Date
  ): GroupCallParticipant | null {
    const userId = socketUserId(socket);
    if (!userId) return null;

    const displayName =
      socket.user?.displayName?.trim() || socket.user?.username || "Thành viên";
    const avatarUrl = socket.user?.avatarUrl?.trim();
    return {
      userId,
      socketId: socket.id,
      displayName,
      ...(avatarUrl ? { avatarUrl } : {}),
      joinedAt,
    };
  }

  private serializeGroupParticipant(
    session: GroupSession,
    participant: GroupCallParticipant
  ): Record<string, unknown> {
    return {
      userId: participant.userId,
      socketId: participant.socketId,
      displayName: participant.displayName,
      avatarUrl: participant.avatarUrl ?? null,
      joinedAt: participant.joinedAt.toISOString(),
      isCaller: participant.userId === session.callerUserId,
    };
  }

  private serializeGroupParticipants(
    session: GroupSession
  ): Record<string, unknown>[] {
    return Array.from(session.participants.values()).map((participant) =>
      this.serializeGroupParticipant(session, participant)
    );
  }

  private serializeGroupSession(session: GroupSession): Record<string, unknown> {
    return {
      callId: session.callId,
      conversationId: session.conversationId,
      conversation: {
        id: session.conversationId,
        name: session.groupName,
      },
      callerUserId: session.callerUserId,
      mediaType: session.mediaType,
      status: session.status,
      startedAt: session.startedAt.toISOString(),
      acceptedAt: session.acceptedAt?.toISOString() ?? null,
      participantCount: session.participants.size,
      maxParticipants: MAX_GROUP_CALL_PARTICIPANTS,
      participants: this.serializeGroupParticipants(session),
    };
  }

  private emitToEligibleGroupUsers(
    session: GroupSession,
    eventName: string,
    payload: Record<string, unknown>
  ): void {
    session.eligibleUserIds.forEach((userId) => {
      this.io.to(userId).emit(eventName, payload);
    });
  }

  private removeGroupParticipant(
    session: GroupSession,
    socket: Socket,
    reason: string
  ): void {
    const userId = socketUserId(socket);
    if (!userId) return;
    this.removeGroupParticipantById(session, userId, socket.id, reason);
  }

  private removeGroupParticipantById(
    session: GroupSession,
    userId: string,
    socketId: string,
    reason: string
  ): void {
    if (this.groupCalls.get(session.callId) !== session) return;

    const participant = session.participants.get(userId);
    if (!participant || participant.socketId !== socketId) return;

    const leftAt = new Date();
    session.participants.delete(userId);
    const history = session.participantHistory.get(userId);
    if (history) {
      history.durationMilliseconds += Math.max(
        0,
        leftAt.getTime() - participant.joinedAt.getTime()
      );
      history.lastLeftAt = leftAt;
    }

    if (this.busyUsers.get(userId) === session.callId) {
      this.busyUsers.delete(userId);
    }

    this.emitToEligibleGroupUsers(session, "group-call:participant-left", {
      callId: session.callId,
      conversationId: session.conversationId,
      participant: {
        ...this.serializeGroupParticipant(session, participant),
        leftAt: leftAt.toISOString(),
      },
      reason,
      participantCount: session.participants.size,
    });

    if (session.participants.size === 0) {
      const finalReason =
        session.status === "ringing"
          ? reason === "disconnected"
            ? "disconnected"
            : "canceled"
          : reason === "disconnected"
            ? "disconnected"
            : "ended";
      this.finishGroupCall(session, finalReason);
    }
  }

  private finishGroupCall(session: GroupSession, reason: string): void {
    if (this.groupCalls.get(session.callId) !== session) return;

    const endedAt = new Date();
    if (session.timeout) clearTimeout(session.timeout);

    for (const participant of session.participants.values()) {
      const history = session.participantHistory.get(participant.userId);
      if (history) {
        history.durationMilliseconds += Math.max(
          0,
          endedAt.getTime() - participant.joinedAt.getTime()
        );
        history.lastLeftAt = endedAt;
      }
      if (this.busyUsers.get(participant.userId) === session.callId) {
        this.busyUsers.delete(participant.userId);
      }
    }

    const durationSeconds = callDurationSeconds(
      session.acceptedAt ?? session.startedAt,
      endedAt
    );
    const participants: FinishedGroupParticipant[] = Array.from(
      session.participantHistory.values()
    )
      .map((participant) => ({
        userId: participant.userId,
        displayName: participant.displayName,
        ...(participant.avatarUrl ? { avatarUrl: participant.avatarUrl } : {}),
        joinedAt: new Date(participant.firstJoinedAt),
        leftAt: new Date(participant.lastLeftAt ?? endedAt),
        durationSeconds: Math.max(
          1,
          Math.ceil(participant.durationMilliseconds / 1_000)
        ),
        joinCount: participant.joinCount,
      }))
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());

    this.groupCalls.delete(session.callId);
    if (
      this.groupCallByConversation.get(session.conversationId) === session.callId
    ) {
      this.groupCallByConversation.delete(session.conversationId);
    }

    this.emitToEligibleGroupUsers(session, "group-call:ended", {
      callId: session.callId,
      conversationId: session.conversationId,
      reason,
      mediaType: session.mediaType,
      durationSeconds,
      endedAt: endedAt.toISOString(),
      participantCount: participants.length,
    });

    const finishedCall: FinishedGroupCall = {
      callId: session.callId,
      conversationId: session.conversationId,
      mediaType: session.mediaType,
      callerUserId: session.callerUserId,
      reason,
      durationSeconds,
      startedAt: new Date(session.startedAt),
      ...(session.acceptedAt
        ? { acceptedAt: new Date(session.acceptedAt) }
        : {}),
      endedAt,
      participants,
    };

    void this.persistGroupCallMessageWithRetry(finishedCall).catch((error) => {
      console.error(
        `Không thể lưu lịch sử cuộc gọi nhóm ${finishedCall.callId} sau tất cả lần thử`,
        error
      );
    });
  }

  private async startCall(
    socket: Socket,
    rawPayload: unknown,
    ack: Ack | undefined
  ): Promise<void> {
    try {
      const payload = parseStartPayload(rawPayload);
      if (!payload) {
        acknowledgeError(ack, "INVALID_PAYLOAD", "Dữ liệu cuộc gọi không hợp lệ");
        return;
      }

      const callerUserId = socketUserId(socket);
      if (!callerUserId) {
        acknowledgeError(ack, "UNAUTHORIZED", "Không thể xác định người gọi");
        return;
      }

      if (payload.calleeId === callerUserId) {
        acknowledgeError(ack, "SELF_CALL", "Bạn không thể tự gọi cho chính mình");
        return;
      }

      if (this.busyUsers.has(callerUserId)) {
        acknowledgeError(ack, "CALLER_BUSY", "Bạn đang ở trong một cuộc gọi khác");
        return;
      }

      const conversation = await Conversation.findById(payload.conversationId)
        .select("type participants.userId")
        .lean();

      const participantIds =
        conversation?.participants.map((participant) =>
          participant.userId.toString()
        ) ?? [];
      const uniqueParticipantIds = new Set(participantIds);

      if (
        !conversation ||
        conversation.type !== "direct" ||
        participantIds.length !== 2 ||
        uniqueParticipantIds.size !== 2 ||
        !uniqueParticipantIds.has(callerUserId) ||
        !uniqueParticipantIds.has(payload.calleeId)
      ) {
        acknowledgeError(
          ack,
          "CALL_NOT_ALLOWED",
          "Cuộc trò chuyện không cho phép cuộc gọi này"
        );
        return;
      }

      const blockStatus = await getUserBlockStatus(
        callerUserId,
        payload.calleeId
      );
      if (blockStatus.isBlocked) {
        acknowledgeError(
          ack,
          "USER_BLOCKED",
          blockedInteractionMessage(blockStatus)
        );
        return;
      }

      const [userA, userB] =
        callerUserId < payload.calleeId
          ? [callerUserId, payload.calleeId]
          : [payload.calleeId, callerUserId];
      const friendship = await Friend.findOne({ userA, userB }).lean();
      if (!friendship) {
        acknowledgeError(
          ack,
          "FRIENDSHIP_REQUIRED",
          "Hai người cần kết bạn trước khi gọi điện"
        );
        return;
      }

      // Re-check after the asynchronous database read so two simultaneous starts
      // cannot reserve the same user.
      if (
        !socket.connected ||
        !this.onlineUsers.get(callerUserId)?.has(socket.id)
      ) {
        acknowledgeError(ack, "UNAUTHORIZED", "Kết nối người gọi đã đóng");
        return;
      }

      if (this.busyUsers.has(callerUserId)) {
        acknowledgeError(ack, "CALLER_BUSY", "Bạn đang ở trong một cuộc gọi khác");
        return;
      }
      if (this.busyUsers.has(payload.calleeId)) {
        acknowledgeError(ack, "CALLEE_BUSY", "Người nhận đang bận");
        return;
      }

      let calleeSocketIds = new Set(
        Array.from(this.onlineUsers.get(payload.calleeId) ?? []).filter(
          (socketId) => this.io.sockets.sockets.has(socketId)
        )
      );

      if (calleeSocketIds.size === 0) {
        const callee = await User.findById(payload.calleeId)
          .select("displayName username")
          .lean();
        calleeSocketIds = new Set(
          Array.from(this.onlineUsers.get(payload.calleeId) ?? []).filter(
            (socketId) => this.io.sockets.sockets.has(socketId)
          )
        );

        // The user may reconnect while their display name is being loaded.
        if (calleeSocketIds.size === 0) {
          const calleeName =
            callee?.displayName?.trim() ||
            callee?.username?.trim() ||
            "này";

          acknowledgeError(
            ack,
            "CALLEE_OFFLINE",
            `Người dùng ${calleeName} hiện đã đăng xuất khỏi tài khoản nên không thể nhận cuộc gọi.`
          );
          return;
        }
      }

      const callId = randomUUID();
      const startedAt = new Date();
      const createdAt = startedAt.toISOString();
      const session: Session = {
        callId,
        conversationId: payload.conversationId,
        callerUserId,
        callerSocketId: socket.id,
        calleeUserId: payload.calleeId,
        calleeSocketIds,
        status: "ringing",
        mediaType: payload.mediaType,
        startedAt,
        timeout: setTimeout(() => {
          const current = this.calls.get(callId);
          if (current?.status === "ringing") {
            this.finishCall(current, "no-answer");
          }
        }, CALL_TIMEOUT_MS),
      };

      session.timeout.unref?.();
      this.calls.set(callId, session);
      this.busyUsers.set(callerUserId, callId);
      this.busyUsers.set(payload.calleeId, callId);

      acknowledge(ack, {
        ok: true,
        callId,
        createdAt,
        timeoutMs: CALL_TIMEOUT_MS,
        mediaType: payload.mediaType,
      });

      this.io.to(Array.from(calleeSocketIds)).emit("call:incoming", {
        callId,
        conversationId: payload.conversationId,
        caller: {
          id: callerUserId,
          displayName: socket.user?.displayName ?? "",
          avatarUrl: socket.user?.avatarUrl ?? null,
        },
        createdAt,
        timeoutMs: CALL_TIMEOUT_MS,
        mediaType: payload.mediaType,
      });
    } catch (error) {
      console.error("Lỗi khi bắt đầu cuộc gọi", error);
      acknowledgeError(ack, "INTERNAL_ERROR", "Không thể bắt đầu cuộc gọi");
    }
  }

  private async acceptCall(
    socket: Socket,
    rawPayload: unknown,
    ack: Ack | undefined
  ): Promise<void> {
    const session = this.getSession(rawPayload, ack);
    if (!session) return;

    const userId = socketUserId(socket);
    if (userId !== session.calleeUserId) {
      acknowledgeError(ack, "FORBIDDEN", "Bạn không thể nhận cuộc gọi này");
      return;
    }

    if (session.status !== "ringing") {
      acknowledgeError(ack, "CALL_ALREADY_ANSWERED", "Cuộc gọi đã được nhận");
      return;
    }


    const blockStatus = await getUserBlockStatus(
      session.calleeUserId,
      session.callerUserId
    );
    if (blockStatus.isBlocked) {
      acknowledgeError(
        ack,
        "USER_BLOCKED",
        blockedInteractionMessage(blockStatus)
      );
      this.finishCall(session, "declined");
      return;
    }

    session.status = "active";
    session.acceptedCalleeSocketId = socket.id;
    session.calleeSocketIds = new Set([socket.id]);
    clearTimeout(session.timeout);

    const acceptedAt = new Date();
    session.acceptedAt = acceptedAt;
    acknowledge(ack, { ok: true });
    this.io.to(session.callerSocketId).emit("call:accepted", {
      callId: session.callId,
      acceptedAt: acceptedAt.toISOString(),
      mediaType: session.mediaType,
    });

    const otherCalleeSockets = Array.from(
      this.onlineUsers.get(session.calleeUserId) ?? []
    ).filter((socketId) => socketId !== socket.id);

    if (otherCalleeSockets.length > 0) {
      this.io.to(otherCalleeSockets).emit("call:ended", {
        callId: session.callId,
        conversationId: session.conversationId,
        reason: "answered-elsewhere",
        mediaType: session.mediaType,
        durationSeconds: 0,
      });
    }
  }

  private rejectCall(socket: Socket, rawPayload: unknown, ack: Ack | undefined): void {
    const session = this.getSession(rawPayload, ack);
    if (!session) return;

    if (socketUserId(socket) !== session.calleeUserId) {
      acknowledgeError(ack, "FORBIDDEN", "Bạn không thể từ chối cuộc gọi này");
      return;
    }

    if (session.status !== "ringing") {
      acknowledgeError(ack, "INVALID_CALL_STATE", "Cuộc gọi không còn chờ trả lời");
      return;
    }

    let reason = "declined";
    if (isRecord(rawPayload) && rawPayload.reason !== undefined) {
      if (
        typeof rawPayload.reason !== "string" ||
        !REJECT_REASONS.has(rawPayload.reason)
      ) {
        acknowledgeError(ack, "INVALID_PAYLOAD", "Lý do từ chối không hợp lệ");
        return;
      }
      reason = rawPayload.reason;
    }

    acknowledge(ack, { ok: true });
    this.finishCall(session, reason);
  }

  private cancelCall(socket: Socket, rawPayload: unknown, ack: Ack | undefined): void {
    const session = this.getSession(rawPayload, ack);
    if (!session) return;

    if (socket.id !== session.callerSocketId) {
      acknowledgeError(ack, "FORBIDDEN", "Bạn không thể hủy cuộc gọi này");
      return;
    }

    if (session.status !== "ringing") {
      acknowledgeError(ack, "INVALID_CALL_STATE", "Cuộc gọi không còn chờ trả lời");
      return;
    }

    acknowledge(ack, { ok: true });
    this.finishCall(session, "canceled");
  }

  private endActiveCall(
    socket: Socket,
    rawPayload: unknown,
    ack: Ack | undefined
  ): void {
    const session = this.getSession(rawPayload, ack);
    if (!session) return;

    if (session.status !== "active") {
      acknowledgeError(ack, "INVALID_CALL_STATE", "Cuộc gọi chưa được kết nối");
      return;
    }

    if (
      socket.id !== session.callerSocketId &&
      socket.id !== session.acceptedCalleeSocketId
    ) {
      acknowledgeError(ack, "FORBIDDEN", "Bạn không thể kết thúc cuộc gọi này");
      return;
    }

    let reason = "ended";
    if (isRecord(rawPayload) && rawPayload.reason !== undefined) {
      if (
        typeof rawPayload.reason !== "string" ||
        !END_REASONS.has(rawPayload.reason)
      ) {
        acknowledgeError(ack, "INVALID_PAYLOAD", "Lý do kết thúc không hợp lệ");
        return;
      }
      reason = rawPayload.reason;
    }

    acknowledge(ack, { ok: true });
    this.finishCall(session, reason);
  }

  private relaySignal(socket: Socket, rawPayload: unknown, ack: Ack | undefined): void {
    const session = this.getSession(rawPayload, ack);
    if (!session) return;

    if (session.status !== "active" || !session.acceptedCalleeSocketId) {
      acknowledgeError(ack, "INVALID_CALL_STATE", "Cuộc gọi chưa được kết nối");
      return;
    }

    if (!isRecord(rawPayload)) {
      acknowledgeError(ack, "INVALID_PAYLOAD", "Tín hiệu cuộc gọi không hợp lệ");
      return;
    }

    const signal = parseSignal(rawPayload.signal);
    if (!signal) {
      acknowledgeError(ack, "INVALID_SIGNAL", "Tín hiệu WebRTC không hợp lệ");
      return;
    }

    const fromCaller = socket.id === session.callerSocketId;
    const fromCallee = socket.id === session.acceptedCalleeSocketId;
    if (!fromCaller && !fromCallee) {
      acknowledgeError(ack, "FORBIDDEN", "Bạn không thể gửi tín hiệu cho cuộc gọi này");
      return;
    }

    if (
      (signal.type === "offer" && !fromCaller) ||
      (signal.type === "answer" && !fromCallee)
    ) {
      acknowledgeError(ack, "INVALID_SIGNAL", "Hướng tín hiệu WebRTC không hợp lệ");
      return;
    }

    const peerSocketId = fromCaller
      ? session.acceptedCalleeSocketId
      : session.callerSocketId;

    if (!this.io.sockets.sockets.has(peerSocketId)) {
      acknowledgeError(ack, "PEER_UNAVAILABLE", "Thiết bị bên kia đã mất kết nối");
      this.finishCall(session, "disconnected");
      return;
    }

    this.io.to(peerSocketId).emit("call:signal", {
      callId: session.callId,
      signal,
    });
    acknowledge(ack, { ok: true });
  }

  private getSession(rawPayload: unknown, ack: Ack | undefined): Session | null {
    const payload = parseCallIdPayload(rawPayload);
    if (!payload) {
      acknowledgeError(ack, "INVALID_PAYLOAD", "Mã cuộc gọi không hợp lệ");
      return null;
    }

    const session = this.calls.get(payload.callId);
    if (!session) {
      acknowledgeError(ack, "STALE_CALL", "Cuộc gọi không còn tồn tại");
      return null;
    }

    return session;
  }

  private finishCall(session: Session, reason: string): void {
    if (this.calls.get(session.callId) !== session) return;

    const endedAt = new Date();
    const durationSeconds = callDurationSeconds(
      session.acceptedAt ?? session.startedAt,
      endedAt
    );

    clearTimeout(session.timeout);
    this.calls.delete(session.callId);

    if (this.busyUsers.get(session.callerUserId) === session.callId) {
      this.busyUsers.delete(session.callerUserId);
    }
    if (this.busyUsers.get(session.calleeUserId) === session.callId) {
      this.busyUsers.delete(session.calleeUserId);
    }

    const recipients = new Set<string>([
      session.callerSocketId,
      ...session.calleeSocketIds,
    ]);
    if (session.acceptedCalleeSocketId) {
      recipients.add(session.acceptedCalleeSocketId);
    }

    if (recipients.size > 0) {
      this.io.to(Array.from(recipients)).emit("call:ended", {
        callId: session.callId,
        conversationId: session.conversationId,
        reason,
        mediaType: session.mediaType,
        durationSeconds,
      });
    }

    const finishedCall: FinishedCall = {
      callId: session.callId,
      conversationId: session.conversationId,
      mediaType: session.mediaType,
      callerUserId: session.callerUserId,
      calleeUserId: session.calleeUserId,
      reason,
      durationSeconds,
      startedAt: new Date(session.startedAt),
      ...(session.acceptedAt
        ? { acceptedAt: new Date(session.acceptedAt) }
        : {}),
      endedAt,
    };

    void this.persistCallMessageWithRetry(finishedCall).catch((error) => {
      console.error(
        `Không thể lưu lịch sử cuộc gọi ${finishedCall.callId} sau tất cả lần thử`,
        error
      );
    });
  }

  private async persistCallMessageWithRetry(
    finishedCall: FinishedCall
  ): Promise<void> {
    let lastError: unknown;
    const maximumAttempts = CALL_HISTORY_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        await this.persistCallMessage(finishedCall);
        return;
      } catch (error) {
        lastError = error;
        if (attempt === maximumAttempts) break;

        const retryDelayMs = CALL_HISTORY_RETRY_DELAYS_MS[attempt - 1];
        console.warn(
          `Lưu lịch sử cuộc gọi ${finishedCall.callId} thất bại ở lần ${attempt}; thử lại sau ${retryDelayMs}ms`,
          error
        );
        await waitBeforeCallHistoryRetry(retryDelayMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Không thể lưu lịch sử cuộc gọi");
  }

  private async persistCallMessage(finishedCall: FinishedCall): Promise<void> {
    const conversation = await Conversation.findById(
      finishedCall.conversationId
    );
    if (!conversation) {
      throw new Error("Conversation không còn tồn tại");
    }

    const senderId = new Types.ObjectId(finishedCall.callerUserId);
    let message = await Message.findOne({
      conversationId: conversation._id,
      messageType: "call",
      "call.callId": finishedCall.callId,
    });

    // A previous attempt may have inserted the message and then failed while
    // saving the conversation. Reusing it makes each retry idempotent without
    // requiring a new unique index or changing existing database records.
    if (!message) {
      message = await Message.create({
        conversationId: conversation._id,
        senderId,
        content:
          finishedCall.mediaType === "video"
            ? "Cuộc gọi video"
            : "Cuộc gọi thoại",
        messageType: "call",
        call: {
          callId: finishedCall.callId,
          callType: "direct",
          mediaType: finishedCall.mediaType,
          callerId: senderId,
          calleeId: new Types.ObjectId(finishedCall.calleeUserId),
          reason: finishedCall.reason,
          durationSeconds: finishedCall.durationSeconds,
          startedAt: finishedCall.startedAt,
          ...(finishedCall.acceptedAt
            ? { acceptedAt: finishedCall.acceptedAt }
            : {}),
          endedAt: finishedCall.endedAt,
        },
      });
    }

    const messageId = message._id.toString();
    const currentLastMessageId = conversation.lastMessage?._id?.toString();
    const hasNewerLastMessage = Boolean(
      conversation.lastMessageAt &&
        conversation.lastMessageAt.getTime() > message.createdAt.getTime()
    );

    if (currentLastMessageId === messageId) {
      // The first save succeeded but a later socket emit may have thrown. Keep
      // the richer snapshot without incrementing unread counters a second time.
      conversation.set({
        lastMessageAt: message.createdAt,
        lastMessage: getLastMessageSnapshot(message, senderId),
      });
      await conversation.save();
    } else if (!hasNewerLastMessage) {
      updateConversationAfterCreateMessage(conversation, message, senderId);
      await conversation.save();
    }

    emitNewMessage(this.io, conversation, message);
  }

  private async persistGroupCallMessageWithRetry(
    finishedCall: FinishedGroupCall
  ): Promise<void> {
    let lastError: unknown;
    const maximumAttempts = CALL_HISTORY_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        await this.persistGroupCallMessage(finishedCall);
        return;
      } catch (error) {
        lastError = error;
        if (attempt === maximumAttempts) break;

        const retryDelayMs = CALL_HISTORY_RETRY_DELAYS_MS[attempt - 1];
        console.warn(
          `Lưu lịch sử cuộc gọi nhóm ${finishedCall.callId} thất bại ở lần ${attempt}; thử lại sau ${retryDelayMs}ms`,
          error
        );
        await waitBeforeCallHistoryRetry(retryDelayMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Không thể lưu lịch sử cuộc gọi nhóm");
  }

  private async persistGroupCallMessage(
    finishedCall: FinishedGroupCall
  ): Promise<void> {
    const conversation = await Conversation.findById(
      finishedCall.conversationId
    );
    if (!conversation || conversation.type !== "group") {
      throw new Error("Cuộc trò chuyện nhóm không còn tồn tại");
    }
    if (conversation.group?.dissolvedAt) return;

    const senderId = new Types.ObjectId(finishedCall.callerUserId);
    let message = await Message.findOne({
      conversationId: conversation._id,
      messageType: "call",
      "call.callId": finishedCall.callId,
    });

    if (!message) {
      const participants: ICallParticipant[] = finishedCall.participants.map(
        (participant) => ({
          userId: new Types.ObjectId(participant.userId),
          displayName: participant.displayName,
          ...(participant.avatarUrl ? { avatarUrl: participant.avatarUrl } : {}),
          joinedAt: participant.joinedAt,
          leftAt: participant.leftAt,
          durationSeconds: participant.durationSeconds,
          joinCount: participant.joinCount,
        })
      );

      message = await Message.create({
        conversationId: conversation._id,
        senderId,
        content:
          finishedCall.mediaType === "video"
            ? "Cuộc gọi video nhóm"
            : "Cuộc gọi thoại nhóm",
        messageType: "call",
        call: {
          callId: finishedCall.callId,
          callType: "group",
          mediaType: finishedCall.mediaType,
          callerId: senderId,
          participantCount: participants.length,
          participants,
          reason: finishedCall.reason,
          durationSeconds: finishedCall.durationSeconds,
          startedAt: finishedCall.startedAt,
          ...(finishedCall.acceptedAt
            ? { acceptedAt: finishedCall.acceptedAt }
            : {}),
          endedAt: finishedCall.endedAt,
        },
      });
    }

    const messageId = message._id.toString();
    const currentLastMessageId = conversation.lastMessage?._id?.toString();
    const hasNewerLastMessage = Boolean(
      conversation.lastMessageAt &&
        conversation.lastMessageAt.getTime() > message.createdAt.getTime()
    );

    if (currentLastMessageId === messageId) {
      conversation.set({
        lastMessageAt: message.createdAt,
        lastMessage: getLastMessageSnapshot(message, senderId),
      });
      await conversation.save();
    } else if (!hasNewerLastMessage) {
      updateConversationAfterCreateMessage(conversation, message, senderId);
      await conversation.save();
    }

    emitNewMessage(this.io, conversation, message);
  }
}

export { CALL_TIMEOUT_MS, MAX_GROUP_CALL_PARTICIPANTS };
