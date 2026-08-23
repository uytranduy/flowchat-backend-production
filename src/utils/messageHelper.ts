import { HydratedDocument, Types } from "mongoose";
import {
  IConversation,
  ILastMessage,
} from "../models/Conversation.js";
import { IMessage } from "../models/Message.js";
import { Server } from "socket.io";

export const getMessagePreview = (
  message: Pick<IMessage, "content" | "messageType" | "attachment">
): string | undefined => {
  const caption = message.content?.trim();
  if (message.messageType !== "attachment" || !message.attachment) {
    return caption || undefined;
  }

  const attachmentLabel =
    message.attachment.kind === "image"
      ? "📷 Hình ảnh"
      : message.attachment.kind === "video"
        ? "🎬 Video"
        : `📎 ${message.attachment.fileName}`;

  return caption ? `${attachmentLabel} · ${caption}` : attachmentLabel;
};

export const getLastMessageSnapshot = (
  message: HydratedDocument<IMessage>,
  senderId: Types.ObjectId | string
): ILastMessage => ({
  _id: message._id.toString(),
  // Attachment metadata carries its own preview label. Keeping only the
  // optional caption here avoids duplicating labels after a REST refresh.
  content:
    message.messageType === "attachment"
      ? message.content?.trim() || undefined
      : getMessagePreview(message),
  senderId: new Types.ObjectId(senderId),
  createdAt: message.createdAt,
  messageType: message.messageType,
  ...(message.call
    ? {
        call: {
          callId: message.call.callId,
          callType: message.call.callType ?? "direct",
          mediaType: message.call.mediaType,
          callerId: message.call.callerId,
          ...(message.call.calleeId ? { calleeId: message.call.calleeId } : {}),
          ...(typeof message.call.participantCount === "number"
            ? { participantCount: message.call.participantCount }
            : {}),
          reason: message.call.reason,
          durationSeconds: message.call.durationSeconds,
          startedAt: message.call.startedAt,
          ...(message.call.acceptedAt
            ? { acceptedAt: message.call.acceptedAt }
            : {}),
          endedAt: message.call.endedAt,
        },
      }
    : {}),
  ...(message.attachment
    ? {
        attachment: {
          kind: message.attachment.kind,
          fileName: message.attachment.fileName,
        },
      }
    : {}),
  isRecalled: Boolean(message.isRecalled),
});

export const updateConversationAfterCreateMessage = (
  conversation: HydratedDocument<IConversation>,
  message: HydratedDocument<IMessage>,
  senderId: Types.ObjectId | string
): void => {
  conversation.set({
    seenBy: [],
    lastMessageAt: message.createdAt,
    lastMessage: getLastMessageSnapshot(message, senderId),
  });

  conversation.participants.forEach((p) => {
    const memberId = p.userId.toString();
    const isSender = memberId === senderId.toString();
    const prevCount = conversation.unreadCounts.get(memberId) || 0;
    conversation.unreadCounts.set(memberId, isSender ? 0 : prevCount + 1);
  });
};

export const emitNewMessage = (
  io: Server,
  conversation: HydratedDocument<IConversation>,
  message: HydratedDocument<IMessage>
): void => {
  const preview = getMessagePreview(message);
  const conversationRoom = conversation._id.toString();

  // A conversation can be created after a device connected. Join every socket
  // of each participant before emitting so that future real-time updates are
  // not missed on that device.
  conversation.participants.forEach((participant) => {
    io.in(participant.userId.toString()).socketsJoin(conversationRoom);
  });

  io.to(conversationRoom).emit("new-message", {
    message,
    conversation: {
      _id: conversation._id,
      lastMessage: conversation.lastMessage,
      lastMessageAt: conversation.lastMessageAt,
    },
    unreadCounts: conversation.unreadCounts,
  });

  // This user-room event is intentionally separate from `new-message`. It lets
  // every connected web/mobile device show a badge or system notification even
  // if that socket connected before a newly-created conversation room existed.
  conversation.participants.forEach((participant) => {
    const recipientId = participant.userId.toString();
    if (recipientId === message.senderId.toString()) return;

    io.to(recipientId).emit("message-notification", {
      conversationId: conversationRoom,
      messageId: message._id.toString(),
      senderId: message.senderId.toString(),
      messageType: message.messageType,
      preview,
      createdAt: message.createdAt,
      unreadCount: conversation.unreadCounts.get(recipientId) || 0,
    });
  });
};
