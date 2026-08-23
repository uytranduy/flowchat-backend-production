import { Request, Response } from "express";
import Friend from "../models/Friend.js";
import User from "../models/User.js";
import FriendRequest from "../models/FriendRequest.js";
import { Types } from "mongoose";
import {
  blockedInteractionMessage,
  getUserBlockStatus,
} from "../utils/userBlockHelper.js";
import { io } from "../socket/index.js";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

function normalizedObjectId(value: unknown): string | null {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) return null;
  return new Types.ObjectId(value).toString();
}

export const sendFriendRequest = async (req: Request, res: Response): Promise<any> => {
  try {
    const { to: rawTo, message } = req.body ?? {};
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const from = req.user._id;
    const to = normalizedObjectId(rawTo);

    if (!to) {
      return res.status(400).json({ message: "Mã người nhận không hợp lệ" });
    }

    if (message != null && typeof message !== "string") {
      return res.status(400).json({ message: "Lời giới thiệu không hợp lệ" });
    }
    const introduction = typeof message === "string" ? message.trim() : "";
    if (introduction.length > 300) {
      return res
        .status(400)
        .json({ message: "Lời giới thiệu không được vượt quá 300 ký tự" });
    }

    if (from.toString() === to) {
      return res
        .status(400)
        .json({ message: "Không thể gửi lời mời kết bạn cho chính mình" });
    }

    const userExists = await User.exists({ _id: to });

    if (!userExists) {
      return res.status(404).json({ message: "Người dùng không tồn tại" });
    }

    const blockStatus = await getUserBlockStatus(from, to);
    if (blockStatus.isBlocked) {
      return res.status(403).json({
        code: "USER_BLOCKED",
        message: blockedInteractionMessage(blockStatus),
        blockStatus,
      });
    }

    let userA = from.toString();
    let userB = to.toString();

    if (userA > userB) {
      [userA, userB] = [userB, userA];
    }

    const [alreadyFriends, existingRequest] = await Promise.all([
      Friend.findOne({ userA, userB }),
      FriendRequest.findOne({
        $or: [
          { from, to },
          { from: to, to: from },
        ],
      }),
    ]);

    if (alreadyFriends) {
      return res.status(400).json({ message: "Hai người đã là bạn bè" });
    }

    if (existingRequest) {
      return res.status(400).json({ message: "Đã có lời mời kết bạn đang chờ" });
    }

    const request = await FriendRequest.create({
      from,
      to,
      message: introduction || undefined,
    });

    await request.populate([
      { path: "from", select: "_id username displayName avatarUrl" },
      { path: "to", select: "_id username displayName avatarUrl" },
    ]);

    const requestPayload = request.toObject();
    io.to(to).emit("friend-request:received", { request: requestPayload });
    io.to(from.toString()).emit("friend-request:updated", {
      action: "sent",
      requestId: request._id.toString(),
    });

    return res
      .status(201)
      .json({ message: "Gửi lời mời kết bạn thành công", request: requestPayload });
  } catch (error) {
    console.error("Lỗi khi gửi yêu cầu kết bạn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const acceptFriendRequest = async (req: Request, res: Response): Promise<any> => {
  try {
    const { requestId } = req.params;
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const userId = req.user._id;

    const request = await FriendRequest.findById(requestId);

    if (!request) {
      return res.status(404).json({ message: "Không tìm thấy lời mời kết bạn" });
    }

    if (request.to.toString() !== userId.toString()) {
      return res
        .status(403)
        .json({ message: "Bạn không có quyền chấp nhận lời mời này" });
    }

    const blockStatus = await getUserBlockStatus(userId, request.from);
    if (blockStatus.isBlocked) {
      return res.status(403).json({
        code: "USER_BLOCKED",
        message: blockedInteractionMessage(blockStatus),
        blockStatus,
      });
    }

    const [userA, userB] =
      request.from.toString() < request.to.toString()
        ? [request.from, request.to]
        : [request.to, request.from];
    await Friend.findOneAndUpdate(
      { userA, userB },
      { $setOnInsert: { userA, userB } },
      { upsert: true, new: true }
    );

    await FriendRequest.deleteMany({
      $or: [
        { from: request.from, to: request.to },
        { from: request.to, to: request.from },
      ],
    });

    const from = await User.findById(request.from)
      .select("_id displayName avatarUrl")
      .lean();

    const updatedRequestId = request._id.toString();
    io.to(userId.toString()).emit("friend-request:updated", {
      action: "accepted",
      requestId: updatedRequestId,
    });
    io.to(request.from.toString()).emit("friend-request:updated", {
      action: "accepted",
      requestId: updatedRequestId,
    });

    return res.status(200).json({
      message: "Chấp nhận lời mời kết bạn thành công",
      newFriend: {
        _id: from?._id,
        displayName: from?.displayName,
        avatarUrl: from?.avatarUrl,
      },
    });
  } catch (error) {
    console.error("Lỗi khi chấp nhận lời mời kết bạn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const getFriendRelationship = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const currentUserId = req.user._id.toString();
    const otherUserId = normalizedObjectId(req.params.userId);
    if (!otherUserId || otherUserId === currentUserId) {
      return res.status(400).json({ message: "Mã người dùng không hợp lệ" });
    }

    const [userA, userB] =
      currentUserId < otherUserId
        ? [currentUserId, otherUserId]
        : [otherUserId, currentUserId];
    const [friendship, request, blockStatus] = await Promise.all([
      Friend.findOne({ userA, userB }).lean(),
      FriendRequest.findOne({
        $or: [
          { from: currentUserId, to: otherUserId },
          { from: otherUserId, to: currentUserId },
        ],
      }).lean(),
      getUserBlockStatus(currentUserId, otherUserId),
    ]);
    const isFriend = Boolean(friendship);
    const direction = request
      ? request.to.toString() === currentUserId
        ? "incoming"
        : "outgoing"
      : null;

    return res.status(200).json({
      isFriend,
      canCall: isFriend && !blockStatus.isBlocked,
      canSendMessage:
        !blockStatus.isBlocked &&
        (isFriend || !request || direction === "outgoing"),
      blockStatus,
      request: request
        ? {
            _id: request._id,
            from: request.from,
            to: request.to,
            message: request.message ?? "",
            createdAt: request.createdAt,
            direction,
          }
        : null,
    });
  } catch (error) {
    console.error("Lỗi khi lấy trạng thái quan hệ", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const declineFriendRequest = async (req: Request, res: Response): Promise<any> => {
  try {
    const { requestId } = req.params;
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const userId = req.user._id;

    const request = await FriendRequest.findById(requestId);

    if (!request) {
      return res.status(404).json({ message: "Không tìm thấy lời mời kết bạn" });
    }

    if (request.to.toString() !== userId.toString()) {
      return res
        .status(403)
        .json({ message: "Bạn không có quyền từ chối lời mời này" });
    }

    await FriendRequest.findByIdAndDelete(requestId);

    io.to(userId.toString()).emit("friend-request:updated", {
      action: "declined",
      requestId,
    });
    io.to(request.from.toString()).emit("friend-request:updated", {
      action: "declined",
      requestId,
    });

    return res.sendStatus(204);
  } catch (error) {
    console.error("Lỗi khi từ chối lời mời kết bạn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const getAllFriends = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const userId = req.user._id;

    const friendships = await Friend.find({
      $or: [
        {
          userA: userId,
        },
        {
          userB: userId,
        },
      ],
    })
      .populate<{ userA: any; userB: any }>("userA", "_id displayName avatarUrl username")
      .populate<{ userA: any; userB: any }>("userB", "_id displayName avatarUrl username")
      .lean();

    if (!friendships.length) {
      return res.status(200).json({ friends: [] });
    }

    const friends = friendships.map((f) =>
      f.userA._id.toString() === userId.toString() ? f.userB : f.userA
    );

    return res.status(200).json({ friends });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách bạn bè", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const getFriendRequests = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const userId = req.user._id;

    const populateFields = "_id username displayName avatarUrl";

    const [sent, received] = await Promise.all([
      FriendRequest.find({ from: userId }).populate("to", populateFields),
      FriendRequest.find({ to: userId }).populate("from", populateFields),
    ]);

    res.status(200).json({ sent, received });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách yêu cầu kết bạn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};
