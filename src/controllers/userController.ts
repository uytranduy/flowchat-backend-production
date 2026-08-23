import { Request, Response } from "express";
import { uploadImageFromBuffer } from "../middlewares/uploadMiddleware.js";
import User from "../models/User.js";
import bcrypt from "bcrypt";
import { Types } from "mongoose";
import { broadcastOnlineUsers, io, isUserOnline } from "../socket/index.js";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const PROFILE_FIELDS = "_id username email displayName avatarUrl bio phone showOnlineStatus notificationsEnabled lastSeenAt createdAt updatedAt";
const PRIVATE_PROFILE_FIELDS = `${PROFILE_FIELDS} googleId hashedPassword`;

function privateUserPayload(user: InstanceType<typeof User>) {
  const raw = user.toObject();
  const {
    googleId,
    hashedPassword,
    emailVerificationTokenHash: _emailVerificationTokenHash,
    emailVerificationExpiresAt: _emailVerificationExpiresAt,
    passwordResetTokenHash: _passwordResetTokenHash,
    passwordResetExpiresAt: _passwordResetExpiresAt,
    ...safeUser
  } = raw;
  void _emailVerificationTokenHash;
  void _emailVerificationExpiresAt;
  void _passwordResetTokenHash;
  void _passwordResetExpiresAt;
  return {
    ...safeUser,
    authProvider: googleId && !hashedPassword ? "google" : "local",
  };
}

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, maximum);
}

export const authMe = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const user = await User.findById(req.user._id).select(PRIVATE_PROFILE_FIELDS);
    if (!user) return res.status(404).json({ message: "Người dùng không tồn tại" });

    return res.status(200).json({
      user: privateUserPayload(user),
    });
  } catch (error) {
    console.error("Lỗi khi gọi authMe", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const searchUserByUsername = async (req: Request, res: Response): Promise<any> => {
  try {
    const { username } = req.query;

    if (!username || typeof username !== "string" || username.trim() === "") {
      return res.status(400).json({ message: "Cần cung cấp username trong query." });
    }

    const user = await User.findOne({ username }).select(
      "_id displayName username avatarUrl bio"
    );

    return res.status(200).json({ user });
  } catch (error) {
    console.error("Lỗi xảy ra khi searchUserByUsername", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const getPublicUser = async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = typeof req.params.userId === "string" && OBJECT_ID_PATTERN.test(req.params.userId)
      ? new Types.ObjectId(req.params.userId)
      : null;
    if (!userId) return res.status(400).json({ message: "Mã người dùng không hợp lệ" });
    const user = await User.findById(userId).select("_id username displayName avatarUrl bio showOnlineStatus lastSeenAt").lean();
    if (!user) return res.status(404).json({ message: "Người dùng không tồn tại" });
    const showOnlineStatus = user.showOnlineStatus !== false;
    return res.status(200).json({
      user: {
        _id: user._id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        isOnline: showOnlineStatus && isUserOnline(user._id.toString()),
        lastSeenAt: user.lastSeenAt ?? null,
        presenceVisible: true,
      },
    });
  } catch (error) {
    console.error("Lỗi khi lấy hồ sơ công khai", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const updateProfile = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user) return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    const displayName = cleanText(req.body?.displayName, 80);
    const username = cleanText(req.body?.username, 30)?.toLowerCase();
    const email = cleanText(req.body?.email, 160)?.toLowerCase();
    const phone = cleanText(req.body?.phone ?? "", 30) ?? "";
    const bio = cleanText(req.body?.bio ?? "", 500) ?? "";
    if (!displayName || !username || !email) {
      return res.status(400).json({ message: "Tên hiển thị, tên người dùng và email không được để trống" });
    }
    if (!/^[a-z0-9._]{3,30}$/.test(username)) {
      return res.status(400).json({ message: "Tên người dùng chỉ gồm chữ thường, số, dấu chấm hoặc gạch dưới" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Email không hợp lệ" });
    }
    const duplicate = await User.findOne({
      _id: { $ne: req.user._id },
      $or: [{ username }, { email }],
    }).select("username email").lean();
    if (duplicate) {
      return res.status(409).json({
        message: duplicate.username === username ? "Tên người dùng đã tồn tại" : "Email đã được sử dụng",
      });
    }
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { displayName, username, email, phone, bio } },
      { new: true, runValidators: true }
    ).select(PRIVATE_PROFILE_FIELDS);
    if (!user) return res.status(404).json({ message: "Người dùng không tồn tại" });
    const payload = privateUserPayload(user);
    io.to(req.user._id.toString()).emit("user-profile:updated", { user: payload });
    return res.status(200).json({ message: "Đã cập nhật hồ sơ", user: payload });
  } catch (error) {
    console.error("Lỗi khi cập nhật hồ sơ", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const updatePreferences = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user) return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    const updates: Record<string, boolean | Date> = {};
    if (typeof req.body?.showOnlineStatus === "boolean") {
      updates.showOnlineStatus = req.body.showOnlineStatus;
      if (!req.body.showOnlineStatus) updates.lastSeenAt = new Date();
    }
    if (typeof req.body?.notificationsEnabled === "boolean") updates.notificationsEnabled = req.body.notificationsEnabled;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "Không có cấu hình hợp lệ để cập nhật" });
    }
    const user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true }).select(PRIVATE_PROFILE_FIELDS);
    if (!user) return res.status(404).json({ message: "Người dùng không tồn tại" });
    await broadcastOnlineUsers();
    return res.status(200).json({ message: "Đã cập nhật cấu hình", user: privateUserPayload(user) });
  } catch (error) {
    console.error("Lỗi khi cập nhật cấu hình", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const changePassword = async (req: Request, res: Response): Promise<any> => {
  try {
    if (!req.user) return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
    if (newPassword.length < 8) return res.status(400).json({ message: "Mật khẩu mới phải có ít nhất 8 ký tự" });
    const user = await User.findById(req.user._id).select("+hashedPassword googleId");
    if (!user) return res.status(404).json({ message: "Người dùng không tồn tại" });
    if (user.googleId && !user.hashedPassword) {
      return res.status(400).json({
        code: "GOOGLE_ACCOUNT",
        message:
          "Tài khoản này đăng nhập bằng Google và không sử dụng mật khẩu FlowChat. Vui lòng đổi mật khẩu tại Google.",
      });
    }
    if (user.hashedPassword) {
      const correct = await bcrypt.compare(currentPassword, user.hashedPassword);
      if (!correct) return res.status(400).json({ message: "Mật khẩu hiện tại không đúng" });
    }
    user.hashedPassword = await bcrypt.hash(newPassword, 10);
    await user.save();
    return res.status(200).json({ message: "Đã đổi mật khẩu" });
  } catch (error) {
    console.error("Lỗi khi đổi mật khẩu", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const uploadAvatar = async (req: Request, res: Response): Promise<any> => {
  try {
    const file = req.file;
    if (!req.user) {
      return res.status(401).json({ message: "Không tìm thấy thông tin người dùng" });
    }
    const userId = req.user._id;

    if (!file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const result = await uploadImageFromBuffer(file.buffer);

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        avatarUrl: result.secure_url,
        avatarId: result.public_id,
      },
      {
        new: true,
      }
    ).select("avatarUrl");

    if (!updatedUser || !updatedUser.avatarUrl) {
      return res.status(400).json({ message: "Avatar trả về null" });
    }

    return res.status(200).json({ avatarUrl: updatedUser.avatarUrl });
  } catch (error) {
    console.error("Lỗi xảy ra khi upload avatar", error);
    return res.status(500).json({ message: "Upload failed" });
  }
};
