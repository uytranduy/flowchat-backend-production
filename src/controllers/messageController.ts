import { Request, Response } from "express";
import { HydratedDocument, Types } from "mongoose";
import Conversation, { IConversation } from "../models/Conversation.js";
import Message, {
  AttachmentResourceType,
  IMessage,
  IMessageAttachment,
  IReplyToMessage,
} from "../models/Message.js";
import {
  emitNewMessage,
  updateConversationAfterCreateMessage,
} from "../utils/messageHelper.js";
import { io } from "../socket/index.js";
import {
  destroyMessageFile,
  getMessageAttachmentKind,
  MESSAGE_ATTACHMENT_LIMITS,
  sanitizeAttachmentFileName,
  uploadMessageFileFromBuffer,
} from "../middlewares/uploadMiddleware.js";
import {
  presentMessagesWithReactionUsers,
} from "../utils/messagePresenter.js";
import {
  blockedInteractionMessage,
  getUserBlockStatus,
} from "../utils/userBlockHelper.js";
import Friend from "../models/Friend.js";
import FriendRequest from "../models/FriendRequest.js";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const REACTION_EMOJIS = new Set(["👍", "❤️", "😂", "😮", "😢", "😡"]);
const RECALLED_MESSAGE_CONTENT = "Tin nhắn đã thu hồi";

type ConversationDocument = HydratedDocument<IConversation>;
type MessageDocument = HydratedDocument<IMessage>;

type ControllerFailure = {
  error: {
    status: number;
    message: string;
  };
};

type MessageContext = {
  message: MessageDocument;
  conversation: ConversationDocument;
};

type ReplyResolution =
  | { replyTo?: IReplyToMessage }
  | ControllerFailure;

type OutgoingMessageResolution =
  | {
      content?: string;
      messageType: "text" | "attachment";
      attachment?: IMessageAttachment;
    }
  | ControllerFailure;

function normalizedObjectId(value: unknown): string | null {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    return null;
  }

  return new Types.ObjectId(value).toString();
}

function isParticipant(
  conversation: ConversationDocument,
  userId: Types.ObjectId | string
): boolean {
  const normalizedUserId = userId.toString();
  return conversation.participants.some(
    (participant) => participant.userId.toString() === normalizedUserId
  );
}

function isExpectedDirectConversation(
  conversation: ConversationDocument,
  senderId: Types.ObjectId,
  recipientId: string
): boolean {
  if (conversation.type !== "direct" || conversation.participants.length !== 2) {
    return false;
  }

  const participantIds = new Set(
    conversation.participants.map((participant) => participant.userId.toString())
  );
  return participantIds.has(senderId.toString()) && participantIds.has(recipientId);
}

async function emitMessageUpdates(
  messages: MessageDocument[]
): Promise<Array<Record<string, unknown>>> {
  const presentedMessages = await presentMessagesWithReactionUsers(messages);
  presentedMessages.forEach((message, index) => {
    io.to(messages[index].conversationId.toString()).emit("message-updated", {
      message,
    });
  });
  return presentedMessages;
}

async function resolveReply(
  rawReplyToMessageId: unknown,
  conversationId: Types.ObjectId
): Promise<ReplyResolution> {
  if (
    rawReplyToMessageId === undefined ||
    rawReplyToMessageId === null ||
    rawReplyToMessageId === ""
  ) {
    return {};
  }

  const replyToMessageId = normalizedObjectId(rawReplyToMessageId);
  if (!replyToMessageId) {
    return {
      error: {
        status: 400,
        message: "Mã tin nhắn được trả lời không hợp lệ",
      },
    };
  }

  const repliedMessage = await Message.findById(replyToMessageId);
  if (!repliedMessage) {
    return {
      error: {
        status: 404,
        message: "Không tìm thấy tin nhắn được trả lời",
      },
    };
  }

  if (repliedMessage.conversationId.toString() !== conversationId.toString()) {
    return {
      error: {
        status: 400,
        message: "Chỉ có thể trả lời tin nhắn trong cùng cuộc trò chuyện",
      },
    };
  }

  if (repliedMessage.isRecalled) {
    return {
      error: {
        status: 400,
        message: "Không thể trả lời tin nhắn đã thu hồi",
      },
    };
  }

  return {
    replyTo: {
      messageId: new Types.ObjectId(repliedMessage._id.toString()),
      senderId: new Types.ObjectId(repliedMessage.senderId.toString()),
      ...(typeof repliedMessage.content === "string"
        ? { content: repliedMessage.content }
        : {}),
      messageType: repliedMessage.messageType,
      ...(repliedMessage.attachment
        ? {
            attachment: {
              kind: repliedMessage.attachment.kind,
              fileName: repliedMessage.attachment.fileName,
            },
          }
        : {}),
      isRecalled: false,
    },
  };
}

async function loadMessageContext(
  rawMessageId: unknown,
  userId: Types.ObjectId
): Promise<MessageContext | ControllerFailure> {
  const messageId = normalizedObjectId(rawMessageId);
  if (!messageId) {
    return {
      error: {
        status: 400,
        message: "Mã tin nhắn không hợp lệ",
      },
    };
  }

  const message = await Message.findById(messageId);
  if (!message) {
    return {
      error: {
        status: 404,
        message: "Không tìm thấy tin nhắn",
      },
    };
  }

  const conversation = await Conversation.findById(message.conversationId);
  if (!conversation) {
    return {
      error: {
        status: 404,
        message: "Không tìm thấy cuộc trò chuyện của tin nhắn",
      },
    };
  }

  if (!isParticipant(conversation, userId)) {
    return {
      error: {
        status: 403,
        message: "Bạn không có quyền thao tác với tin nhắn này",
      },
    };
  }

  return { message, conversation };
}

function respondWithFailure(res: Response, failure: ControllerFailure): Response {
  return res.status(failure.error.status).json({ message: failure.error.message });
}

async function resolveOutgoingMessage(
  rawContent: unknown,
  file?: Express.Multer.File
): Promise<OutgoingMessageResolution> {
  if (
    rawContent !== undefined &&
    rawContent !== null &&
    typeof rawContent !== "string"
  ) {
    return {
      error: {
        status: 400,
        message: "Nội dung tin nhắn không hợp lệ",
      },
    };
  }

  const content = typeof rawContent === "string" ? rawContent.trim() : "";
  if (!file) {
    if (!content) {
      return {
        error: {
          status: 400,
          message: "Thiếu nội dung hoặc tệp đính kèm",
        },
      };
    }

    return { content, messageType: "text" };
  }

  const kind = getMessageAttachmentKind(file.mimetype, file.originalname);
  if (!kind) {
    return {
      error: {
        status: 415,
        message: "Định dạng tệp không được hỗ trợ",
      },
    };
  }

  const maxBytes = MESSAGE_ATTACHMENT_LIMITS[kind];
  if (file.size > maxBytes) {
    return {
      error: {
        status: 413,
        message: `${
          kind === "image" ? "Ảnh" : kind === "video" ? "Video" : "Tệp"
        } không được vượt quá ${Math.floor(maxBytes / 1024 / 1024)} MB`,
      },
    };
  }

  const resourceType: AttachmentResourceType =
    kind === "image" ? "image" : kind === "video" ? "video" : "raw";
  const uploadResult = await uploadMessageFileFromBuffer(
    file.buffer,
    resourceType,
    file.originalname
  );

  const attachment: IMessageAttachment = {
    kind,
    url: uploadResult.secure_url,
    publicId: uploadResult.public_id,
    fileName: sanitizeAttachmentFileName(file.originalname),
    mimeType: file.mimetype.toLowerCase().split(";")[0].trim(),
    sizeBytes:
      typeof uploadResult.bytes === "number" ? uploadResult.bytes : file.size,
    resourceType,
    ...(typeof uploadResult.width === "number"
      ? { width: uploadResult.width }
      : {}),
    ...(typeof uploadResult.height === "number"
      ? { height: uploadResult.height }
      : {}),
    ...(typeof uploadResult.duration === "number"
      ? { durationSeconds: uploadResult.duration }
      : {}),
  };

  return {
    ...(content ? { content } : {}),
    messageType: "attachment",
    attachment,
  };
}

async function cleanupUnpersistedAttachment(
  attachment?: IMessageAttachment
): Promise<void> {
  if (!attachment) return;

  try {
    await destroyMessageFile(attachment.publicId, attachment.resourceType);
  } catch (cleanupError) {
    console.error(
      `Không thể dọn tệp chưa được lưu ${attachment.publicId}`,
      cleanupError
    );
  }
}

export const sendDirectMessage = async (
  req: Request,
  res: Response
): Promise<any> => {
  let uploadedAttachment: IMessageAttachment | undefined;
  let messagePersisted = false;

  try {
    const { recipientId: rawRecipientId, content, conversationId, replyToMessageId } =
      req.body ?? {};
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const senderId = req.user._id;
    const recipientId = normalizedObjectId(rawRecipientId);

    if (!recipientId) {
      return res.status(400).json({ message: "Mã người nhận không hợp lệ" });
    }

    const blockStatus = await getUserBlockStatus(senderId, recipientId);
    if (blockStatus.isBlocked) {
      return res.status(403).json({
        code: "USER_BLOCKED",
        message: blockedInteractionMessage(blockStatus),
        blockStatus,
      });
    }

    const senderIdText = senderId.toString();
    const [userA, userB] =
      senderIdText < recipientId
        ? [senderIdText, recipientId]
        : [recipientId, senderIdText];
    const [friendship, pendingRequest] = await Promise.all([
      Friend.findOne({ userA, userB }).lean(),
      FriendRequest.findOne({
        $or: [
          { from: senderId, to: recipientId },
          { from: recipientId, to: senderId },
        ],
      }),
    ]);

    if (
      !friendship &&
      pendingRequest &&
      pendingRequest.to.toString() === senderIdText
    ) {
      return res.status(403).json({
        code: "MESSAGE_REQUEST_REQUIRES_ACCEPTANCE",
        message:
          "Bạn cần chấp nhận lời mời nhắn tin trước khi trả lời người này",
        requestId: pendingRequest._id,
      });
    }

    let createdMessageRequest = false;
    if (!friendship && !pendingRequest) {
      await FriendRequest.create({
        from: senderId,
        to: new Types.ObjectId(recipientId),
        message:
          typeof content === "string" && content.trim()
            ? content.trim().slice(0, 300)
            : "Đã gửi cho bạn một tệp đính kèm",
      });
      createdMessageRequest = true;
    }

    let conversation: ConversationDocument | null = null;

    if (conversationId !== undefined && conversationId !== null && conversationId !== "") {
      const normalizedConversationId = normalizedObjectId(conversationId);
      if (!normalizedConversationId) {
        return res.status(400).json({ message: "Mã cuộc trò chuyện không hợp lệ" });
      }

      conversation = await Conversation.findById(normalizedConversationId);
      if (!conversation) {
        return res.status(404).json({ message: "Không tìm thấy cuộc trò chuyện" });
      }

      if (!isExpectedDirectConversation(conversation, senderId, recipientId)) {
        return res.status(403).json({
          message: "Bạn không có quyền gửi tin nhắn vào cuộc trò chuyện này",
        });
      }
    } else {
      conversation = await Conversation.findOne({
        type: "direct",
        "participants.userId": {
          $all: [senderId, new Types.ObjectId(recipientId)],
        },
      });

      if (conversation && !isExpectedDirectConversation(conversation, senderId, recipientId)) {
        conversation = null;
      }

      if (!conversation) {
        if (
          replyToMessageId !== undefined &&
          replyToMessageId !== null &&
          replyToMessageId !== ""
        ) {
          return res.status(400).json({
            message: "Cần cung cấp cuộc trò chuyện khi trả lời tin nhắn",
          });
        }

        conversation = await Conversation.create({
          type: "direct",
          participants: [
            { userId: senderId, joinedAt: new Date() },
            { userId: new Types.ObjectId(recipientId), joinedAt: new Date() },
          ],
          lastMessageAt: new Date(),
          unreadCounts: new Map(),
        });
      }
    }

    const replyResolution = await resolveReply(replyToMessageId, conversation._id);
    if ("error" in replyResolution) {
      return respondWithFailure(res, replyResolution);
    }

    const outgoingMessage = await resolveOutgoingMessage(content, req.file);
    if ("error" in outgoingMessage) {
      return respondWithFailure(res, outgoingMessage);
    }
    uploadedAttachment = outgoingMessage.attachment;

    const message = await Message.create({
      conversationId: conversation._id,
      senderId,
      messageType: outgoingMessage.messageType,
      ...(outgoingMessage.content ? { content: outgoingMessage.content } : {}),
      ...(outgoingMessage.attachment
        ? { attachment: outgoingMessage.attachment }
        : {}),
      ...(replyResolution.replyTo ? { replyTo: replyResolution.replyTo } : {}),
    });
    messagePersisted = true;

    updateConversationAfterCreateMessage(conversation, message, senderId);
    await conversation.save();
    emitNewMessage(io, conversation, message);

    return res.status(201).json({
      message,
      messageRequestCreated: createdMessageRequest,
    });
  } catch (error) {
    if (!messagePersisted) {
      await cleanupUnpersistedAttachment(uploadedAttachment);
    }
    console.error("Lỗi xảy ra khi gửi tin nhắn trực tiếp", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const sendGroupMessage = async (
  req: Request,
  res: Response
): Promise<any> => {
  let uploadedAttachment: IMessageAttachment | undefined;
  let messagePersisted = false;

  try {
    const { content, replyToMessageId } = req.body ?? {};
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const senderId = req.user._id;
    const conversation = req.conversation;

    if (!conversation) {
      return res.status(400).json({
        message: "Cuộc trò chuyện nhóm không tồn tại trong request",
      });
    }
    if (conversation.group?.dissolvedAt) {
      return res.status(409).json({ message: "Nhóm đã bị giải tán nên không thể gửi tin nhắn" });
    }

    const replyResolution = await resolveReply(replyToMessageId, conversation._id);
    if ("error" in replyResolution) {
      return respondWithFailure(res, replyResolution);
    }

    const outgoingMessage = await resolveOutgoingMessage(content, req.file);
    if ("error" in outgoingMessage) {
      return respondWithFailure(res, outgoingMessage);
    }
    uploadedAttachment = outgoingMessage.attachment;

    const message = await Message.create({
      conversationId: conversation._id,
      senderId,
      messageType: outgoingMessage.messageType,
      ...(outgoingMessage.content ? { content: outgoingMessage.content } : {}),
      ...(outgoingMessage.attachment
        ? { attachment: outgoingMessage.attachment }
        : {}),
      ...(replyResolution.replyTo ? { replyTo: replyResolution.replyTo } : {}),
    });
    messagePersisted = true;

    updateConversationAfterCreateMessage(conversation, message, senderId);
    await conversation.save();
    emitNewMessage(io, conversation, message);

    return res.status(201).json({ message });
  } catch (error) {
    if (!messagePersisted) {
      await cleanupUnpersistedAttachment(uploadedAttachment);
    }
    console.error("Lỗi xảy ra khi gửi tin nhắn nhóm", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const recallMessage = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const context = await loadMessageContext(req.params.messageId, req.user._id);
    if ("error" in context) {
      return respondWithFailure(res, context);
    }

    const { message, conversation } = context;
    if (message.senderId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        message: "Bạn chỉ có thể thu hồi tin nhắn do mình gửi",
      });
    }

    if (message.messageType !== "text" && message.messageType !== "attachment") {
      return res.status(400).json({
        message: "Không thể thu hồi lịch sử cuộc gọi",
      });
    }

    if (message.isRecalled) {
      const [presentedMessage] = await presentMessagesWithReactionUsers([message]);
      return res.status(200).json({ message: presentedMessage });
    }

    message.set({
      isRecalled: true,
      recalledAt: new Date(),
      content: "",
    });
    message.set("imgUrl", undefined);
    message.set("pinnedAt", undefined);
    message.set("pinnedBy", undefined);
    // Soft recall: remove the client-facing reference but never delete the
    // Cloudinary asset or the message record here.
    message.set("attachment", undefined);
    await message.save();

    await Message.updateMany(
      {
        "replyTo.messageId": message._id,
        "replyTo.isRecalled": { $ne: true },
      },
      { $set: { "replyTo.isRecalled": true } }
    );

    if (conversation.lastMessage?._id?.toString() === message._id.toString()) {
      conversation.set({
        "lastMessage.content": RECALLED_MESSAGE_CONTENT,
        "lastMessage.isRecalled": true,
        "lastMessage.attachment": undefined,
      });
      await conversation.save();
    }

    const updatedReplies = await Message.find({
      "replyTo.messageId": message._id,
      "replyTo.isRecalled": true,
    });
    const [presentedMessage] = await emitMessageUpdates([
      message,
      ...updatedReplies,
    ]);

    return res.status(200).json({ message: presentedMessage });
  } catch (error) {
    console.error("Lỗi xảy ra khi thu hồi tin nhắn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const updateMessageReaction = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const emoji = req.body?.emoji;
    if (typeof emoji !== "string" || !REACTION_EMOJIS.has(emoji)) {
      return res.status(400).json({
        message: "Biểu tượng cảm xúc không hợp lệ",
        allowedEmojis: Array.from(REACTION_EMOJIS),
      });
    }

    const context = await loadMessageContext(req.params.messageId, req.user._id);
    if ("error" in context) {
      return respondWithFailure(res, context);
    }

    const { message } = context;
    if (message.isRecalled) {
      return res.status(400).json({
        message: "Không thể thả cảm xúc vào tin nhắn đã thu hồi",
      });
    }

    const userId = req.user._id.toString();
    const currentReaction = message.reactions.find(
      (reaction) => reaction.userId.toString() === userId
    );
    const reactions = message.reactions
      .filter((reaction) => reaction.userId.toString() !== userId)
      .map((reaction) => ({
        userId: reaction.userId,
        emoji: reaction.emoji,
        createdAt: reaction.createdAt,
      }));

    if (currentReaction?.emoji !== emoji) {
      reactions.push({
        userId: new Types.ObjectId(userId),
        emoji,
        createdAt: new Date(),
      });
    }

    message.set("reactions", reactions);
    await message.save();
    const [presentedMessage] = await emitMessageUpdates([message]);

    return res.status(200).json({ message: presentedMessage });
  } catch (error) {
    console.error("Lỗi xảy ra khi cập nhật cảm xúc tin nhắn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const removeMessageReaction = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const context = await loadMessageContext(req.params.messageId, req.user._id);
    if ("error" in context) {
      return respondWithFailure(res, context);
    }

    const { message } = context;
    const userId = req.user._id.toString();
    const reactions = message.reactions
      .filter((reaction) => reaction.userId.toString() !== userId)
      .map((reaction) => ({
        userId: reaction.userId,
        emoji: reaction.emoji,
        createdAt: reaction.createdAt,
      }));

    message.set("reactions", reactions);
    await message.save();
    const [presentedMessage] = await emitMessageUpdates([message]);

    return res.status(200).json({ message: presentedMessage });
  } catch (error) {
    console.error("Lỗi xảy ra khi xóa cảm xúc tin nhắn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const forwardMessage = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const sourceContext = await loadMessageContext(
      req.params.messageId,
      req.user._id
    );
    if ("error" in sourceContext) {
      return respondWithFailure(res, sourceContext);
    }

    const targetConversationId = normalizedObjectId(req.body?.conversationId);
    if (!targetConversationId) {
      return res.status(400).json({ message: "Mã cuộc trò chuyện đích không hợp lệ" });
    }

    const targetConversation = await Conversation.findById(targetConversationId);
    if (!targetConversation) {
      return res.status(404).json({ message: "Không tìm thấy cuộc trò chuyện đích" });
    }

    if (!isParticipant(targetConversation, req.user._id)) {
      return res.status(403).json({
        message: "Bạn không có quyền chuyển tiếp vào cuộc trò chuyện này",
      });
    }

    if (targetConversation.type === "direct") {
      const recipient = targetConversation.participants.find(
        (participant) =>
          participant.userId.toString() !== req.user?._id.toString()
      );
      if (!recipient) {
        return res.status(400).json({
          message: "Cuộc trò chuyện trực tiếp không hợp lệ",
        });
      }

      const blockStatus = await getUserBlockStatus(
        req.user._id,
        recipient.userId
      );
      if (blockStatus.isBlocked) {
        return res.status(403).json({
          code: "USER_BLOCKED",
          message: blockedInteractionMessage(blockStatus),
          blockStatus,
        });
      }
    }

    const sourceMessage = sourceContext.message;
    if (sourceMessage.isRecalled) {
      return res.status(400).json({
        message: "Không thể chuyển tiếp tin nhắn đã thu hồi",
      });
    }

    if (sourceMessage.messageType === "system") {
      return res.status(400).json({
        message: "Không thể chuyển tiếp thông báo hệ thống",
      });
    }

    const forwardedMessage = await Message.create({
      conversationId: targetConversation._id,
      senderId: req.user._id,
      messageType: sourceMessage.messageType,
      ...(typeof sourceMessage.content === "string"
        ? { content: sourceMessage.content }
        : {}),
      ...(typeof sourceMessage.imgUrl === "string"
        ? { imgUrl: sourceMessage.imgUrl }
        : {}),
      ...(sourceMessage.attachment
        ? {
            attachment: {
              kind: sourceMessage.attachment.kind,
              url: sourceMessage.attachment.url,
              publicId: sourceMessage.attachment.publicId,
              fileName: sourceMessage.attachment.fileName,
              mimeType: sourceMessage.attachment.mimeType,
              sizeBytes: sourceMessage.attachment.sizeBytes,
              resourceType: sourceMessage.attachment.resourceType,
              ...(typeof sourceMessage.attachment.width === "number"
                ? { width: sourceMessage.attachment.width }
                : {}),
              ...(typeof sourceMessage.attachment.height === "number"
                ? { height: sourceMessage.attachment.height }
                : {}),
              ...(typeof sourceMessage.attachment.durationSeconds === "number"
                ? {
                    durationSeconds:
                      sourceMessage.attachment.durationSeconds,
                  }
                : {}),
            },
        }
        : {}),
      ...(sourceMessage.call ? { call: sourceMessage.call } : {}),
      forwardedFrom: {
        messageId: sourceMessage._id,
      },
    });

    updateConversationAfterCreateMessage(
      targetConversation,
      forwardedMessage,
      req.user._id
    );
    await targetConversation.save();
    emitNewMessage(io, targetConversation, forwardedMessage);

    return res.status(201).json({ message: forwardedMessage });
  } catch (error) {
    console.error("Lỗi xảy ra khi chuyển tiếp tin nhắn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};
