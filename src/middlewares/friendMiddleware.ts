import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import Conversation from "../models/Conversation.js";
import Friend from "../models/Friend.js";
import {
  blockedInteractionMessage,
  getUserBlockStatus,
} from "../utils/userBlockHelper.js";

const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

const normalizedObjectId = (value: unknown): string | null => {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    return null;
  }

  return new Types.ObjectId(value).toString();
};

export const checkFriendship = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const me = req.user._id.toString();
    const rawRecipientId = req.body?.recipientId ?? null;
    const rawMemberIds = req.body?.memberIds ?? [];

    if (!Array.isArray(rawMemberIds)) {
      return res.status(400).json({ message: "Danh sách thành viên không hợp lệ" });
    }

    const memberIds = rawMemberIds.map(normalizedObjectId);
    if (memberIds.some((memberId) => !memberId)) {
      return res.status(400).json({ message: "Danh sách thành viên chứa mã không hợp lệ" });
    }

    const recipientId = rawRecipientId
      ? normalizedObjectId(rawRecipientId)
      : null;

    if (rawRecipientId && !recipientId) {
      return res.status(400).json({ message: "Mã người nhận không hợp lệ" });
    }

    if (!recipientId && memberIds.length === 0) {
      return res
        .status(400)
        .json({ message: "Cần cung cấp recipientId hoặc memberIds" });
    }

    if (recipientId) {
      req.body.recipientId = recipientId;
      const blockStatus = await getUserBlockStatus(me, recipientId);
      if (blockStatus.isBlocked) {
        return res.status(403).json({
          code: "USER_BLOCKED",
          message: blockedInteractionMessage(blockStatus),
          blockStatus,
        });
      }

      const [userA, userB] = pair(me, recipientId);

      const isFriend = await Friend.findOne({ userA, userB });

      if (!isFriend) {
        return res.status(403).json({ message: "Bạn chưa kết bạn với người này" });
      }

      return next();
    }

    const normalizedMemberIds = memberIds as string[];
    req.body.memberIds = normalizedMemberIds;

    if (req.body?.type === "direct" && normalizedMemberIds.length > 0) {
      const blockStatus = await getUserBlockStatus(me, normalizedMemberIds[0]);
      if (blockStatus.isBlocked) {
        return res.status(403).json({
          code: "USER_BLOCKED",
          message: blockedInteractionMessage(blockStatus),
          blockStatus,
        });
      }

      // A direct conversation may be created before friendship so the first
      // message can become a message request. Replying/calling is enforced by
      // the message and call layers until the recipient accepts it.
      return next();
    }

    const friendChecks = normalizedMemberIds.map(async (memberId) => {
      const [userA, userB] = pair(me, memberId);
      const friend = await Friend.findOne({ userA, userB });
      return friend ? null : memberId;
    });

    const results = await Promise.all(friendChecks);
    const notFriends = results.filter((id): id is string => id !== null);

    if (notFriends.length > 0) {
      return res
        .status(403)
        .json({ message: "Bạn chỉ có thể thêm bạn bè vào nhóm.", notFriends });
    }

    next();
  } catch (error) {
    console.error("Lỗi xảy ra khi checkFriendship:", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const checkGroupMembership = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.body ?? {};
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const userId = req.user._id;
    const normalizedConversationId = normalizedObjectId(conversationId);

    if (!normalizedConversationId) {
      return res.status(400).json({ message: "Mã cuộc trò chuyện không hợp lệ" });
    }

    const conversation = await Conversation.findById(normalizedConversationId);

    if (!conversation) {
      return res.status(404).json({ message: "Không tìm thấy cuộc trò chuyện" });
    }

    const isMember = conversation.participants.some(
      (p) => p.userId.toString() === userId.toString()
    );

    if (!isMember) {
      return res.status(403).json({ message: "Bạn không ở trong group này." });
    }

    if (conversation.type !== "group") {
      return res.status(400).json({ message: "Đây không phải là cuộc trò chuyện nhóm" });
    }

    req.body.conversationId = normalizedConversationId;
    req.conversation = conversation;

    next();
  } catch (error) {
    console.error("Lỗi checkGroupMembership:", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const checkConversationMembership = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const conversationId = normalizedObjectId(req.params.conversationId);
    if (!conversationId) {
      return res.status(400).json({ message: "Mã cuộc trò chuyện không hợp lệ" });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      "participants.userId": req.user._id,
      hiddenFor: { $ne: req.user._id },
    });
    if (!conversation) {
      // Do not reveal whether a conversation exists to non-members.
      return res.status(404).json({ message: "Không tìm thấy cuộc trò chuyện" });
    }

    req.params.conversationId = conversationId;
    req.conversation = conversation;
    next();
  } catch (error) {
    console.error("Lỗi khi kiểm tra thành viên cuộc trò chuyện", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};
