import { Request, Response } from "express";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import { io } from "../socket/index.js";
import { HydratedDocument, Types } from "mongoose";
import type { IConversation } from "../models/Conversation.js";
import { presentMessagesWithReactionUsers } from "../utils/messagePresenter.js";
import Friend from "../models/Friend.js";
import User from "../models/User.js";
import {
  emitNewMessage,
  updateConversationAfterCreateMessage,
} from "../utils/messageHelper.js";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

function normalizedObjectId(value: unknown): string | null {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) return null;
  return new Types.ObjectId(value).toString();
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function escapedRegExp(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

async function presentConversation(conversationId: string) {
  const conversation = await Conversation.findById(conversationId)
    .populate({
      path: "participants.userId",
      select: "displayName username avatarUrl bio showOnlineStatus lastSeenAt",
    })
    .populate({ path: "lastMessage.senderId", select: "displayName avatarUrl" })
    .populate({ path: "seenBy", select: "displayName avatarUrl" });
  if (!conversation) return null;
  const raw = conversation.toObject() as any;
  return {
    ...raw,
    unreadCounts: raw.unreadCounts || {},
    participants: (raw.participants || []).map((participant: any) => ({
      _id: participant.userId?._id,
      displayName: participant.userId?.displayName,
      username: participant.userId?.username,
      avatarUrl: participant.userId?.avatarUrl ?? null,
      bio: participant.userId?.bio ?? null,
      lastSeenAt: participant.userId?.lastSeenAt ?? null,
      presenceVisible: true,
      joinedAt: participant.joinedAt,
    })),
  };
}

async function createGroupSystemMessage(
  conversation: HydratedDocument<IConversation>,
  senderId: Types.ObjectId | string,
  content: string
) {
  const message = await Message.create({
    conversationId: conversation._id,
    senderId,
    content,
    messageType: "system",
  });
  updateConversationAfterCreateMessage(conversation, message, senderId);
  await conversation.save();
  emitNewMessage(io, conversation, message);
  return message;
}

export const addGroupMember = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user || !req.conversation) return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    const conversation = req.conversation;
    if (conversation.type !== "group") return res.status(400).json({ message: "Đây không phải cuộc trò chuyện nhóm" });
    if (conversation.group?.dissolvedAt) return res.status(409).json({ message: "Nhóm đã bị giải tán" });
    const isOwner = conversation.group?.createdBy?.toString() === req.user._id.toString();
    if (!isOwner && conversation.group?.allowMembersToInvite === false) {
      return res.status(403).json({ message: "Trưởng nhóm đã tắt quyền mời thành viên" });
    }
    const memberId = normalizedObjectId(req.body?.userId);
    if (!memberId) return res.status(400).json({ message: "Mã người dùng không hợp lệ" });
    if (conversation.participants.some((participant) => participant.userId.toString() === memberId)) {
      return res.status(409).json({ message: "Người dùng đã ở trong nhóm" });
    }
    const [memberExists, friendship] = await Promise.all([
      User.exists({ _id: memberId }),
      Friend.exists({
        $or: [
          { userA: req.user._id, userB: memberId },
          { userA: memberId, userB: req.user._id },
        ],
      }),
    ]);
    if (!memberExists) return res.status(404).json({ message: "Người dùng không tồn tại" });
    if (!friendship) return res.status(403).json({ message: "Bạn chỉ có thể thêm bạn bè của mình vào nhóm" });

    const updatedConversation = await Conversation.findOneAndUpdate(
      { _id: conversation._id, "participants.userId": { $ne: memberId } },
      { $push: { participants: { userId: new Types.ObjectId(memberId), joinedAt: new Date() } } },
      { new: true }
    );
    if (!updatedConversation) return res.status(409).json({ message: "Người dùng đã ở trong nhóm" });
    const member = await User.findById(memberId).select("displayName");
    await createGroupSystemMessage(
      updatedConversation,
      memberId,
      `${member?.displayName || "Một thành viên"} đã vào nhóm ${conversation.group?.name || "nhóm chat"}`
    );
    const formatted = await presentConversation(conversation._id.toString());
    if (!formatted) return res.status(404).json({ message: "Không tìm thấy cuộc trò chuyện" });

    io.in(memberId).socketsJoin(conversation._id.toString());
    io.to(memberId).emit("new-group", formatted);
    io.to(conversation._id.toString()).emit("conversation:updated", formatted);
    return res.status(200).json({ message: "Đã thêm thành viên vào nhóm", conversation: formatted });
  } catch (error) {
    console.error("Lỗi khi thêm thành viên nhóm", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const updateGroupInvitePermission = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user || !req.conversation) return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    const conversation = req.conversation;
    if (conversation.type !== "group") return res.status(400).json({ message: "Đây không phải cuộc trò chuyện nhóm" });
    if (conversation.group?.dissolvedAt) return res.status(409).json({ message: "Nhóm đã bị giải tán" });
    if (conversation.group?.createdBy?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Chỉ trưởng nhóm mới có thể thay đổi quyền của nhóm" });
    }
    const allowMembersToInvite = req.body?.allowMembersToInvite;
    const allowMembersToRename = req.body?.allowMembersToRename;
    const hasInviteSetting = typeof allowMembersToInvite === "boolean";
    const hasRenameSetting = typeof allowMembersToRename === "boolean";
    if (!hasInviteSetting && !hasRenameSetting) {
      return res.status(400).json({ message: "Cài đặt quyền nhóm không hợp lệ" });
    }
    const settings: Record<string, boolean> = {};
    if (hasInviteSetting) settings["group.allowMembersToInvite"] = allowMembersToInvite;
    if (hasRenameSetting) settings["group.allowMembersToRename"] = allowMembersToRename;
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: settings }
    );
    const formatted = await presentConversation(conversation._id.toString());
    if (!formatted) return res.status(404).json({ message: "Không tìm thấy cuộc trò chuyện" });
    io.to(conversation._id.toString()).emit("conversation:updated", formatted);
    return res.status(200).json({ message: "Đã cập nhật cài đặt nhóm", conversation: formatted });
  } catch (error) {
    console.error("Lỗi khi cập nhật cài đặt quyền nhóm", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const renameGroup = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user || !req.conversation) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const conversation = req.conversation;
    if (conversation.type !== "group") {
      return res.status(400).json({ message: "Đây không phải cuộc trò chuyện nhóm" });
    }
    if (conversation.group?.dissolvedAt) {
      return res.status(409).json({ message: "Nhóm đã bị giải tán" });
    }
    const isOwner = conversation.group?.createdBy?.toString() === req.user._id.toString();
    if (!isOwner && conversation.group?.allowMembersToRename === false) {
      return res.status(403).json({ message: "Trưởng nhóm đã tắt quyền đổi tên nhóm" });
    }
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 50) {
      return res.status(400).json({ message: "Tên nhóm phải có từ 1 đến 50 ký tự" });
    }
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { "group.name": name } }
    );
    const formatted = await presentConversation(conversation._id.toString());
    if (!formatted) {
      return res.status(404).json({ message: "Không tìm thấy cuộc trò chuyện" });
    }
    io.to(conversation._id.toString()).emit("conversation:updated", formatted);
    return res.status(200).json({ message: "Đã đổi tên nhóm", conversation: formatted });
  } catch (error) {
    console.error("Lỗi khi đổi tên nhóm", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const leaveGroup = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user || !req.conversation) return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    const conversation = req.conversation;
    if (conversation.type !== "group") return res.status(400).json({ message: "Đây không phải cuộc trò chuyện nhóm" });
    if (conversation.group?.dissolvedAt) return res.status(409).json({ message: "Nhóm đã bị giải tán. Bạn có thể xóa nhóm khỏi danh sách." });
    const userId = req.user._id.toString();
    const isOwner = conversation.group?.createdBy?.toString() === userId;
    const nextOwner = isOwner
      ? conversation.participants.find((participant) => participant.userId.toString() !== userId)
      : undefined;

    const update: Record<string, unknown> = {
      $pull: { participants: { userId: req.user._id } },
      $unset: { [`unreadCounts.${userId}`]: "" },
    };
    if (nextOwner) {
      update.$set = { "group.createdBy": nextOwner.userId };
    }

    const updatedConversation = await Conversation.findOneAndUpdate(
      { _id: conversation._id, "participants.userId": req.user._id },
      update,
      { new: true }
    );
    if (!updatedConversation) return res.status(404).json({ message: "Bạn không còn ở trong nhóm này" });

    await createGroupSystemMessage(
      updatedConversation,
      req.user._id,
      `${req.user.displayName || "Một thành viên"} đã rời nhóm ${conversation.group?.name || "nhóm chat"}${nextOwner ? ". Quyền trưởng nhóm đã được chuyển cho thành viên kế tiếp." : ""}`
    );
    const formatted = await presentConversation(conversation._id.toString());
    if (formatted) io.to(conversation._id.toString()).emit("conversation:updated", formatted);
    io.to(userId).emit("conversation:left", { conversationId: conversation._id.toString() });
    io.in(userId).socketsLeave(conversation._id.toString());
    return res.status(200).json({ message: "Đã rời nhóm" });
  } catch (error) {
    console.error("Lỗi khi rời nhóm", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const dissolveGroup = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user || !req.conversation) return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    const conversation = req.conversation;
    if (conversation.type !== "group") return res.status(400).json({ message: "Đây không phải cuộc trò chuyện nhóm" });
    if (conversation.group?.createdBy?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Chỉ trưởng nhóm mới có thể giải tán nhóm" });
    }
    if (conversation.group?.dissolvedAt) return res.status(409).json({ message: "Nhóm đã bị giải tán" });

    await Message.deleteMany({ conversationId: conversation._id });
    conversation.set({
      "group.dissolvedAt": new Date(),
      "group.dissolvedBy": req.user._id,
      seenBy: [],
      lastMessage: null,
      unreadCounts: new Map(),
    });
    await conversation.save();
    await createGroupSystemMessage(
      conversation,
      req.user._id,
      `Nhóm ${conversation.group?.name || "nhóm chat"} đã bị giải tán bởi ${req.user.displayName || "trưởng nhóm"}`
    );

    const formatted = await presentConversation(conversation._id.toString());
    if (!formatted) return res.status(404).json({ message: "Không tìm thấy cuộc trò chuyện" });
    io.to(conversation._id.toString()).emit("conversation:dissolved", formatted);
    io.to(conversation._id.toString()).emit("conversation:updated", formatted);
    return res.status(200).json({ message: "Đã giải tán nhóm", conversation: formatted });
  } catch (error) {
    console.error("Lỗi khi giải tán nhóm", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const removeDissolvedGroup = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user || !req.conversation) return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    const conversation = req.conversation;
    if (conversation.type !== "group" || !conversation.group?.dissolvedAt) {
      return res.status(409).json({ message: "Chỉ có thể xóa nhóm đã giải tán" });
    }
    await Conversation.updateOne(
      { _id: conversation._id },
      { $addToSet: { hiddenFor: req.user._id } }
    );
    io.to(req.user._id.toString()).emit("conversation:removed", {
      conversationId: conversation._id.toString(),
    });
    io.in(req.user._id.toString()).socketsLeave(conversation._id.toString());
    return res.status(200).json({ message: "Đã xóa nhóm khỏi danh sách" });
  } catch (error) {
    console.error("Lỗi khi xóa nhóm đã giải tán", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const transferGroupOwnership = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user || !req.conversation) return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    const conversation = req.conversation;
    if (conversation.type !== "group") return res.status(400).json({ message: "Đây không phải cuộc trò chuyện nhóm" });
    if (conversation.group?.dissolvedAt) return res.status(409).json({ message: "Nhóm đã bị giải tán" });
    if (conversation.group?.createdBy?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Chỉ trưởng nhóm hiện tại mới có thể chuyển quyền" });
    }
    const memberId = normalizedObjectId(req.body?.userId);
    if (!memberId || memberId === req.user._id.toString()) {
      return res.status(400).json({ message: "Hãy chọn một thành viên khác trong nhóm" });
    }
    if (!conversation.participants.some((participant) => participant.userId.toString() === memberId)) {
      return res.status(400).json({ message: "Người được chọn không ở trong nhóm" });
    }
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { "group.createdBy": new Types.ObjectId(memberId) } }
    );
    const formatted = await presentConversation(conversation._id.toString());
    if (!formatted) return res.status(404).json({ message: "Không tìm thấy cuộc trò chuyện" });
    io.to(conversation._id.toString()).emit("conversation:updated", formatted);
    return res.status(200).json({ message: "Đã chuyển quyền trưởng nhóm", conversation: formatted });
  } catch (error) {
    console.error("Lỗi khi chuyển quyền trưởng nhóm", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const createConversation = async (req: Request, res: Response): Promise<any> => {
  try {
    const { type, name, memberIds } = req.body;
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const userId = req.user._id;

    if (
      !type ||
      (type === "group" && !name) ||
      !memberIds ||
      !Array.isArray(memberIds) ||
      memberIds.length === 0
    ) {
      return res
        .status(400)
        .json({ message: "Tên nhóm và danh sách thành viên là bắt buộc" });
    }

    let conversation;

    if (type === "direct") {
      const participantId = memberIds[0];

      conversation = await Conversation.findOne({
        type: "direct",
        "participants.userId": { $all: [userId, participantId] },
      }).sort({
        "lastMessage.createdAt": -1,
        lastMessageAt: -1,
        updatedAt: -1,
      });

      if (!conversation) {
        conversation = new Conversation({
          type: "direct",
          participants: [{ userId }, { userId: participantId }],
          lastMessageAt: new Date(),
        });

        await conversation.save();
      }
    }

    if (type === "group") {
      conversation = new Conversation({
        type: "group",
        participants: [{ userId }, ...memberIds.map((id) => ({ userId: id }))],
        group: {
          name,
          createdBy: userId,
        },
        lastMessageAt: new Date(),
      });

      await conversation.save();
    }

    if (!conversation) {
      return res.status(400).json({ message: "Conversation type không hợp lệ" });
    }

    await conversation.populate([
      {
        path: "participants.userId",
        select: "displayName username avatarUrl bio showOnlineStatus lastSeenAt",
      },
      {
        path: "seenBy",
        select: "displayName avatarUrl",
      },
      { path: "lastMessage.senderId", select: "displayName avatarUrl" },
    ]);

    const participants = (conversation.participants || []).map((p: any) => ({
      _id: p.userId?._id,
      displayName: p.userId?.displayName,
      username: p.userId?.username,
      avatarUrl: p.userId?.avatarUrl ?? null,
      bio: p.userId?.bio ?? null,
      lastSeenAt: p.userId?.lastSeenAt ?? null,
      presenceVisible: true,
      joinedAt: p.joinedAt,
    }));

    const formatted = { ...conversation.toObject(), participants };

    if (type === "group") {
      memberIds.forEach((id: string) => {
        io.to(id).emit("new-group", formatted);
      });
    }

    if (type === "direct") {
      io.to(userId.toString()).emit("new-group", formatted);
      io.to(memberIds[0]).emit("new-group", formatted);
    }

    return res.status(201).json({ conversation: formatted });
  } catch (error) {
    console.error("Lỗi khi tạo conversation", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const getConversations = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const userId = req.user._id;
    const conversations = await Conversation.find({
      "participants.userId": userId,
      hiddenFor: { $ne: userId },
    })
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .populate({
        path: "participants.userId",
        select: "displayName username avatarUrl bio showOnlineStatus lastSeenAt",
      })
      .populate({
        path: "lastMessage.senderId",
        select: "displayName avatarUrl",
      })
      .populate({
        path: "seenBy",
        select: "displayName avatarUrl",
      });

    const formatted = conversations.map((convo: any) => {
      const participants = (convo.participants || []).map((p: any) => ({
        _id: p.userId?._id,
        displayName: p.userId?.displayName,
        username: p.userId?.username,
        avatarUrl: p.userId?.avatarUrl ?? null,
        bio: p.userId?.bio ?? null,
        lastSeenAt: p.userId?.lastSeenAt ?? null,
        presenceVisible: true,
        joinedAt: p.joinedAt,
      }));

      return {
        ...convo.toObject(),
        unreadCounts: convo.unreadCounts || {},
        participants,
      };
    });

    return res.status(200).json({ conversations: formatted });
  } catch (error) {
    console.error("Lỗi xảy ra khi lấy conversations", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const getMessages = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user || !req.conversation) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const conversationId = req.conversation._id;
    const pageLimit = boundedInteger(req.query.limit, 50, 1, 100);
    if (pageLimit === null) {
      return res.status(400).json({ message: "Giới hạn tin nhắn không hợp lệ" });
    }

    const query: {
      conversationId: Types.ObjectId;
      createdAt?: { $lt: Date };
    } = { conversationId };

    if (req.query.cursor !== undefined) {
      if (typeof req.query.cursor !== "string") {
        return res.status(400).json({ message: "Con trỏ tin nhắn không hợp lệ" });
      }
      const cursorDate = new Date(req.query.cursor);
      if (Number.isNaN(cursorDate.getTime())) {
        return res.status(400).json({ message: "Con trỏ tin nhắn không hợp lệ" });
      }
      query.createdAt = { $lt: cursorDate };
    }

    let messageDocuments = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(pageLimit + 1);

    let nextCursor = null;

    if (messageDocuments.length > pageLimit) {
      const nextMessage = messageDocuments[messageDocuments.length - 1];
      nextCursor = nextMessage.createdAt.toISOString();
      messageDocuments.pop();
    }

    messageDocuments = messageDocuments.reverse();
    const messages = await presentMessagesWithReactionUsers(messageDocuments);

    return res.status(200).json({
      messages,
      nextCursor,
    });
  } catch (error) {
    console.error("Lỗi xảy ra khi lấy messages", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const searchMessages = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    if (!req.user || !req.conversation) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const rawQuery = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!rawQuery || rawQuery.length > 100) {
      return res.status(400).json({
        message: "Từ khóa tìm kiếm phải có từ 1 đến 100 ký tự",
      });
    }
    const limit = boundedInteger(req.query.limit, 30, 1, 50);
    if (limit === null) {
      return res.status(400).json({ message: "Giới hạn kết quả không hợp lệ" });
    }

    const pattern = escapedRegExp(rawQuery);
    const documents = await Message.find({
      conversationId: req.conversation._id,
      isRecalled: { $ne: true },
      $or: [{ content: pattern }, { "attachment.fileName": pattern }],
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit);
    const messages = await presentMessagesWithReactionUsers(documents);
    return res.status(200).json({ messages });
  } catch (error) {
    console.error("Lỗi khi tìm kiếm tin nhắn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const getPinnedMessages = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    if (!req.user || !req.conversation) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const documents = await Message.find({
      conversationId: req.conversation._id,
      pinnedAt: { $exists: true, $ne: null },
      isRecalled: { $ne: true },
    }).sort({ pinnedAt: -1, _id: -1 });
    const messages = await presentMessagesWithReactionUsers(documents);
    return res.status(200).json({ messages });
  } catch (error) {
    console.error("Lỗi khi lấy tin nhắn đã ghim", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const getConversationAttachments = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    if (!req.user || !req.conversation) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const kind = typeof req.query.kind === "string" ? req.query.kind : "all";
    if (!["all", "image", "video", "file"].includes(kind)) {
      return res.status(400).json({ message: "Loại tệp đính kèm không hợp lệ" });
    }
    const documents = await Message.find({
      conversationId: req.conversation._id,
      attachment: { $exists: true, $ne: null },
      isRecalled: { $ne: true },
      ...(kind === "all" ? {} : { "attachment.kind": kind }),
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(500);
    const messages = await presentMessagesWithReactionUsers(documents);
    return res.status(200).json({ messages });
  } catch (error) {
    console.error("Lỗi khi lấy tệp đính kèm của cuộc trò chuyện", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const updateMessagePin = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    if (!req.user || !req.conversation) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const messageId = normalizedObjectId(req.params.messageId);
    if (!messageId || typeof req.body?.pinned !== "boolean") {
      return res.status(400).json({ message: "Yêu cầu ghim tin nhắn không hợp lệ" });
    }
    const message = await Message.findOne({
      _id: messageId,
      conversationId: req.conversation._id,
    });
    if (!message) {
      return res.status(404).json({ message: "Không tìm thấy tin nhắn" });
    }
    if (message.isRecalled) {
      return res.status(400).json({ message: "Không thể ghim tin nhắn đã thu hồi" });
    }

    const currentUserId = req.user._id.toString();
    const pinnedBy = message.pinnedBy?.toString();
    if (req.body.pinned) {
      if (message.pinnedAt && pinnedBy && pinnedBy !== currentUserId) {
        return res.status(409).json({
          message: "Tin nhắn này đã được người khác ghim",
        });
      }
      message.set({ pinnedAt: message.pinnedAt ?? new Date(), pinnedBy: req.user._id });
      await message.save();
    } else {
      if (message.pinnedAt && pinnedBy !== currentUserId) {
        return res.status(403).json({
          message: "Chỉ người đã ghim tin nhắn mới có thể bỏ ghim",
        });
      }
      await Message.updateOne(
        { _id: message._id },
        { $unset: { pinnedAt: 1, pinnedBy: 1 } }
      );
    }
    const updatedMessage = await Message.findById(message._id);
    if (!updatedMessage) {
      return res.status(404).json({ message: "Không tìm thấy tin nhắn" });
    }
    const [presented] = await presentMessagesWithReactionUsers([updatedMessage]);
    io.to(req.conversation._id.toString()).emit("message-updated", {
      message: presented,
    });
    io.to(req.conversation._id.toString()).emit("message-pin:updated", {
      conversationId: req.conversation._id.toString(),
      message: presented,
      pinned: Boolean(updatedMessage.pinnedAt),
    });
    return res.status(200).json({ message: presented });
  } catch (error) {
    console.error("Lỗi khi cập nhật ghim tin nhắn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const getMessageById = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    if (!req.user || !req.conversation) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const messageId = normalizedObjectId(req.params.messageId);
    if (!messageId) {
      return res.status(400).json({ message: "Mã tin nhắn không hợp lệ" });
    }

    const messageDocument = await Message.findOne({
      _id: messageId,
      conversationId: req.conversation._id,
    });
    if (!messageDocument) {
      return res.status(404).json({ message: "Không tìm thấy tin nhắn" });
    }

    const [message] = await presentMessagesWithReactionUsers([messageDocument]);
    return res.status(200).json({ message });
  } catch (error) {
    console.error("Lỗi khi lấy tin nhắn theo mã", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const getMessagesAround = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    if (!req.user || !req.conversation) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const messageId = normalizedObjectId(req.params.messageId);
    if (!messageId) {
      return res.status(400).json({ message: "Mã tin nhắn không hợp lệ" });
    }

    const beforeLimit = boundedInteger(req.query.before, 20, 0, 50);
    const afterLimit = boundedInteger(req.query.after, 20, 0, 50);
    if (beforeLimit === null || afterLimit === null) {
      return res.status(400).json({ message: "Phạm vi tin nhắn không hợp lệ" });
    }

    const target = await Message.findOne({
      _id: messageId,
      conversationId: req.conversation._id,
    });
    if (!target) {
      return res.status(404).json({ message: "Không tìm thấy tin nhắn" });
    }

    const [beforeDocuments, afterDocuments] = await Promise.all([
      Message.find({
        conversationId: req.conversation._id,
        $or: [
          { createdAt: { $lt: target.createdAt } },
          { createdAt: target.createdAt, _id: { $lt: target._id } },
        ],
      })
        .sort({ createdAt: -1, _id: -1 })
        .limit(beforeLimit + 1),
      Message.find({
        conversationId: req.conversation._id,
        $or: [
          { createdAt: { $gt: target.createdAt } },
          { createdAt: target.createdAt, _id: { $gt: target._id } },
        ],
      })
        .sort({ createdAt: 1, _id: 1 })
        .limit(afterLimit + 1),
    ]);

    const hasMoreBefore = beforeDocuments.length > beforeLimit;
    const hasMoreAfter = afterDocuments.length > afterLimit;
    const selectedBefore = beforeDocuments.slice(0, beforeLimit).reverse();
    const selectedAfter = afterDocuments.slice(0, afterLimit);
    const messages = await presentMessagesWithReactionUsers([
      ...selectedBefore,
      target,
      ...selectedAfter,
    ]);

    return res.status(200).json({
      messages,
      targetMessageId: target._id.toString(),
      hasMoreBefore,
      hasMoreAfter,
    });
  } catch (error) {
    console.error("Lỗi khi lấy vùng tin nhắn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const getUserConversationsForSocketIO = async (userId: Types.ObjectId): Promise<string[]> => {
  try {
    const conversations = await Conversation.find(
      { "participants.userId": userId, hiddenFor: { $ne: userId } },
      { _id: 1 }
    );

    return conversations.map((c) => c._id.toString());
  } catch (error) {
    console.error("Lỗi khi fetch conversations: ", error);
    return [];
  }
};

export const markAsSeen = async (req: Request, res: Response): Promise<any> => {
  try {
    const { conversationId } = req.params;
    if (!req.user || !req.conversation) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const userId = req.user._id.toString();
    const conversation = req.conversation;

    const last = conversation.lastMessage;

    if (!last) {
      return res.status(200).json({ message: "Không có tin nhắn để mark as seen" });
    }

    if (last.senderId && last.senderId.toString() === userId) {
      return res.status(200).json({ message: "Sender không cần mark as seen" });
    }

    const updated = await Conversation.findOneAndUpdate(
      {
        _id: conversationId,
        "participants.userId": req.user._id,
      },
      {
        $addToSet: { seenBy: new Types.ObjectId(userId) },
        $set: { [`unreadCounts.${userId}`]: 0 },
      },
      {
        new: true,
      }
    );

    if (!updated) {
      return res.status(500).json({ message: "Không thể cập nhật cuộc trò chuyện" });
    }

    io.to(conversationId).emit("read-message", {
      conversation: updated,
      lastMessage: {
        _id: updated.lastMessage?._id,
        content: updated.lastMessage?.content,
        createdAt: updated.lastMessage?.createdAt,
        sender: {
          _id: updated.lastMessage?.senderId,
        },
      },
    });

    return res.status(200).json({
      message: "Marked as seen",
      seenBy: updated.seenBy || [],
      myUnreadCount: updated.unreadCounts?.get(userId) || 0,
    });
  } catch (error) {
    console.error("Lỗi khi mark as seen", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};
