import { Request, Response } from "express";
import { Types } from "mongoose";
import User from "../models/User.js";
import UserBlock from "../models/UserBlock.js";
import { getUserBlockStatus } from "../utils/userBlockHelper.js";
import { io } from "../socket/index.js";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const PUBLIC_USER_FIELDS = "_id username displayName avatarUrl bio";

function normalizedObjectId(value: unknown): string | null {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) return null;
  return new Types.ObjectId(value).toString();
}

export async function blockUser(req: Request, res: Response): Promise<any> {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const currentUserId = req.user._id.toString();
    const blockedUserId = normalizedObjectId(req.params.userId);
    if (!blockedUserId) {
      return res.status(400).json({ message: "Mã người dùng không hợp lệ" });
    }
    if (blockedUserId === currentUserId) {
      return res.status(400).json({ message: "Bạn không thể tự chặn chính mình" });
    }

    const blockedUser = await User.findById(blockedUserId)
      .select(PUBLIC_USER_FIELDS)
      .lean();
    if (!blockedUser) {
      return res.status(404).json({ message: "Người dùng không tồn tại" });
    }

    const blockedAt = new Date();
    const block = await UserBlock.findOneAndUpdate(
      { blockerId: currentUserId, blockedId: blockedUserId },
      {
        $set: { isActive: true, blockedAt },
        $unset: { unblockedAt: 1 },
        $setOnInsert: {
          blockerId: new Types.ObjectId(currentUserId),
          blockedId: new Types.ObjectId(blockedUserId),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    const status = await getUserBlockStatus(currentUserId, blockedUserId);

    const updatePayload = {
      action: "blocked",
      blockerId: currentUserId,
      blockedUserId,
    };
    io.to(currentUserId).emit("user-block:updated", updatePayload);
    io.to(blockedUserId).emit("user-block:updated", updatePayload);

    return res.status(200).json({
      message: "Đã chặn người dùng",
      blockedUser: { ...blockedUser, blockedAt: block.blockedAt },
      status,
    });
  } catch (error) {
    console.error("Lỗi khi chặn người dùng", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
}

export async function unblockUser(req: Request, res: Response): Promise<any> {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const currentUserId = req.user._id.toString();
    const blockedUserId = normalizedObjectId(req.params.userId);
    if (!blockedUserId) {
      return res.status(400).json({ message: "Mã người dùng không hợp lệ" });
    }
    if (blockedUserId === currentUserId) {
      return res.status(400).json({ message: "Mã người dùng không hợp lệ" });
    }

    const block = await UserBlock.findOneAndUpdate(
      {
        blockerId: currentUserId,
        blockedId: blockedUserId,
        isActive: true,
      },
      { $set: { isActive: false, unblockedAt: new Date() } },
      { new: true }
    );

    const status = await getUserBlockStatus(currentUserId, blockedUserId);
    const updatePayload = {
      action: "unblocked",
      blockerId: currentUserId,
      blockedUserId,
    };
    io.to(currentUserId).emit("user-block:updated", updatePayload);
    io.to(blockedUserId).emit("user-block:updated", updatePayload);
    return res.status(200).json({
      message: block ? "Đã bỏ chặn người dùng" : "Người dùng chưa bị bạn chặn",
      blockedUserId,
      status,
    });
  } catch (error) {
    console.error("Lỗi khi bỏ chặn người dùng", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
}

export async function getBlockStatus(req: Request, res: Response): Promise<any> {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const otherUserId = normalizedObjectId(req.params.userId);
    if (!otherUserId) {
      return res.status(400).json({ message: "Mã người dùng không hợp lệ" });
    }

    const status = await getUserBlockStatus(req.user._id, otherUserId);
    return res.status(200).json({ userId: otherUserId, ...status });
  } catch (error) {
    console.error("Lỗi khi kiểm tra trạng thái chặn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
}

export async function getBlockedUsers(req: Request, res: Response): Promise<any> {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const blocks = await UserBlock.find({
      blockerId: req.user._id,
      isActive: true,
    })
      .sort({ blockedAt: -1 })
      .select("blockedId blockedAt")
      .lean();

    const users = await User.find({
      _id: { $in: blocks.map((block) => block.blockedId) },
    })
      .select(PUBLIC_USER_FIELDS)
      .lean();
    const usersById = new Map(users.map((user) => [user._id.toString(), user]));

    const blockedUsers = blocks.flatMap((block) => {
      const user = usersById.get(block.blockedId.toString());
      return user ? [{ ...user, blockedAt: block.blockedAt }] : [];
    });

    return res.status(200).json({ blockedUsers });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách chặn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
}
