import { Request, Response } from "express";
import bcrypt from "bcrypt";
import User, { type IUser } from "../models/User.js";
import type { HydratedDocument } from "mongoose";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import Session from "../models/Session.js";
import { config } from "../config/index.js";
import { OAuth2Client } from "google-auth-library";
import {
  isEmailDeliveryConfigured,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../utils/email.js";

const ACCESS_TOKEN_TTL = "30m"; // thường là dưới 15m
const REFRESH_TOKEN_TTL = 14 * 24 * 60 * 60 * 1000; // 14 ngày
const googleClient = new OAuth2Client();
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

function createOneTimeToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("hex");
  return {
    token,
    hash: crypto.createHash("sha256").update(token).digest("hex"),
  };
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const createAuthenticatedSession = async (
  user: HydratedDocument<IUser>,
  res: Response
) => {
  const accessToken = jwt.sign(
    { userId: user._id },
    config.ACCESS_TOKEN_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );

  const refreshToken = crypto.randomBytes(64).toString("hex");
  await Session.create({
    userId: user._id,
    refreshToken,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL),
  });

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: REFRESH_TOKEN_TTL,
  });

  return accessToken;
};

const createAvailableUsername = async (email: string) => {
  const localPart = email.split("@")[0] || "flowchat";
  let base = localPart
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, "")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 24);
  if (base.length < 3) base = `user${base}`;

  let candidate = base;
  let suffix = 0;
  while (await User.exists({ username: candidate })) {
    suffix += 1;
    candidate = `${base.slice(0, 24 - String(suffix).length)}${suffix}`;
  }
  return candidate;
};

export const signUp = async (req: Request, res: Response): Promise<any> => {
  try {
    const { username, password, email, firstName, lastName } = req.body;

    if (!username || !password || !email || !firstName || !lastName) {
      return res.status(400).json({
        message: "Không thể thiếu username, password, email, firstName, và lastName",
      });
    }

    // kiểm tra username tồn tại chưa
    const normalizedUsername = String(username).trim().toLowerCase();
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!validEmail(normalizedEmail)) {
      return res.status(400).json({ message: "Địa chỉ email không hợp lệ." });
    }
    const normalizedPassword = String(password);
    if (normalizedPassword.length < 6) {
      return res
        .status(400)
        .json({ message: "Mật khẩu phải có ít nhất 6 ký tự." });
    }
    if (!/[!@#$%^&*(),.?":{}|<>_\-+=]/.test(normalizedPassword)) {
      return res.status(400).json({
        message: "Mật khẩu phải có ít nhất một ký tự đặc biệt, ví dụ @ hoặc !.",
      });
    }
    if (!isEmailDeliveryConfigured()) {
      return res.status(503).json({
        code: "EMAIL_NOT_CONFIGURED",
        message:
          "Máy chủ chưa được cấu hình gửi email xác minh. Vui lòng liên hệ quản trị viên.",
      });
    }
    const duplicate = await User.findOne({
      $or: [{ username: normalizedUsername }, { email: normalizedEmail }],
    });

    if (duplicate) {
      return res.status(409).json({
        message:
          duplicate.username === normalizedUsername
            ? "Tên đăng nhập đã tồn tại"
            : "Email đã được sử dụng",
      });
    }

    // mã hoá password
    const hashedPassword = await bcrypt.hash(normalizedPassword, 10); // salt = 10

    // tạo user mới
    const verification = createOneTimeToken();
    const user = await User.create({
      username: normalizedUsername,
      hashedPassword,
      email: normalizedEmail,
      displayName: `${lastName} ${firstName}`,
      emailVerificationRequired: true,
      emailVerificationTokenHash: verification.hash,
      emailVerificationExpiresAt: new Date(
        Date.now() + EMAIL_VERIFICATION_TTL_MS
      ),
    });

    try {
      await sendVerificationEmail({
        to: user.email,
        displayName: user.displayName,
        token: verification.token,
      });
    } catch (error) {
      console.error("Không thể gửi email xác minh", error);
      return res.status(202).json({
        emailSent: false,
        email: user.email,
        message:
          "Tài khoản đã được tạo nhưng chưa gửi được email xác minh. Hãy dùng chức năng gửi lại email xác minh.",
      });
    }

    return res.status(201).json({
      emailSent: true,
      email: user.email,
      message:
        "Đăng ký thành công. Vui lòng mở email và nhấn liên kết xác minh trước khi đăng nhập.",
    });
  } catch (error) {
    console.error("Lỗi khi gọi signUp", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const signIn = async (req: Request, res: Response): Promise<any> => {
  try {
    // lấy inputs
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: "Thiếu username hoặc password." });
    }

    // lấy hashedPassword trong db để so với password input
    const user = await User.findOne({ username });

    if (!user) {
      return res
        .status(401)
        .json({ message: "username hoặc password không chính xác" });
    }

    if (user.emailVerificationRequired) {
      return res.status(403).json({
        code: "EMAIL_NOT_VERIFIED",
        message:
          "Email chưa được xác minh. Vui lòng mở email xác minh hoặc yêu cầu gửi lại liên kết.",
      });
    }

    if (!user.hashedPassword && user.googleId) {
      return res.status(400).json({
        code: "GOOGLE_ACCOUNT",
        message:
          "Tài khoản này đăng nhập bằng Google và không sử dụng mật khẩu FlowChat.",
      });
    }

    // kiểm tra password
    const passwordCorrect = user.hashedPassword
      ? await bcrypt.compare(password, user.hashedPassword)
      : false;

    if (!passwordCorrect) {
      return res
        .status(401)
        .json({ message: "username hoặc password không chính xác" });
    }

    const accessToken = await createAuthenticatedSession(user, res);

    // trả access token về trong res
    return res
      .status(200)
      .json({ message: `User ${user.displayName} đã logged in!`, accessToken });
  } catch (error) {
    console.error("Lỗi khi gọi signIn", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

export const signInWithGoogle = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const idToken = String(req.body?.idToken || "").trim();
    if (!idToken) {
      return res.status(400).json({ message: "Thiếu Google ID token." });
    }
    if (config.GOOGLE_CLIENT_IDS.length === 0) {
      console.error("GOOGLE_CLIENT_IDS chưa được cấu hình.");
      return res.status(503).json({
        message: "Đăng nhập Google chưa được cấu hình trên máy chủ.",
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: config.GOOGLE_CLIENT_IDS,
    });
    const payload = ticket.getPayload();
    const googleId = payload?.sub;
    const email = payload?.email?.trim().toLowerCase();

    if (!payload || !googleId || !email || payload.email_verified !== true) {
      return res.status(401).json({
        message: "Tài khoản Google chưa có email được xác minh.",
      });
    }

    let user = await User.findOne({ googleId });
    if (!user) {
      user = await User.findOne({ email });
      if (user) {
        if (user.googleId && user.googleId !== googleId) {
          return res.status(409).json({
            message: "Email này đã liên kết với một tài khoản Google khác.",
          });
        }
        user.googleId = googleId;
        user.emailVerificationRequired = false;
        user.emailVerifiedAt ??= new Date();
        user.emailVerificationTokenHash = undefined;
        user.emailVerificationExpiresAt = undefined;
        if (!user.avatarUrl && payload.picture) user.avatarUrl = payload.picture;
        await user.save();
      } else {
        user = await User.create({
          username: await createAvailableUsername(email),
          googleId,
          email,
          emailVerificationRequired: false,
          emailVerifiedAt: new Date(),
          displayName: payload.name?.trim() || email.split("@")[0],
          avatarUrl: payload.picture,
        });
      }
    }

    const accessToken = await createAuthenticatedSession(user, res);
    return res.status(200).json({
      message: `User ${user.displayName} đã đăng nhập bằng Google!`,
      accessToken,
    });
  } catch (error) {
    console.error("Lỗi khi đăng nhập Google", error);
    return res.status(401).json({ message: "Google ID token không hợp lệ." });
  }
};

export const verifyEmail = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ message: "Thiếu mã xác minh email." });
    }

    const user = await User.findOne({
      emailVerificationRequired: true,
      emailVerificationTokenHash: tokenHash(token),
      emailVerificationExpiresAt: { $gt: new Date() },
    }).select(
      "+emailVerificationTokenHash +emailVerificationExpiresAt"
    );
    if (!user) {
      return res.status(400).json({
        message:
          "Liên kết xác minh không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu gửi lại email.",
      });
    }

    user.emailVerificationRequired = false;
    user.emailVerifiedAt = new Date();
    user.emailVerificationTokenHash = undefined;
    user.emailVerificationExpiresAt = undefined;
    await user.save();

    return res.status(200).json({
      message: "Email đã được xác minh. Bạn có thể đăng nhập FlowChat.",
    });
  } catch (error) {
    console.error("Lỗi khi xác minh email", error);
    return res.status(500).json({ message: "Không thể xác minh email." });
  }
};

export const resendVerificationEmail = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!validEmail(email)) {
      return res.status(400).json({ message: "Địa chỉ email không hợp lệ." });
    }
    if (!isEmailDeliveryConfigured()) {
      return res.status(503).json({
        message: "Máy chủ chưa được cấu hình gửi email.",
      });
    }

    const user = await User.findOne({ email }).select(
      "+emailVerificationTokenHash +emailVerificationExpiresAt"
    );
    if (!user || !user.emailVerificationRequired) {
      return res.status(200).json({
        message:
          "Nếu email đang chờ xác minh, FlowChat đã gửi một liên kết mới.",
      });
    }

    const verification = createOneTimeToken();
    user.emailVerificationTokenHash = verification.hash;
    user.emailVerificationExpiresAt = new Date(
      Date.now() + EMAIL_VERIFICATION_TTL_MS
    );
    await user.save();
    await sendVerificationEmail({
      to: user.email,
      displayName: user.displayName,
      token: verification.token,
    });

    return res.status(200).json({
      message: "Đã gửi lại liên kết xác minh. Vui lòng kiểm tra email.",
    });
  } catch (error) {
    console.error("Lỗi khi gửi lại email xác minh", error);
    return res.status(502).json({
      message: "Không thể gửi email xác minh. Vui lòng thử lại sau.",
    });
  }
};

export const forgotPassword = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!validEmail(email)) {
      return res.status(400).json({ message: "Địa chỉ email không hợp lệ." });
    }

    const user = await User.findOne({ email }).select(
      "+passwordResetTokenHash +passwordResetExpiresAt"
    );
    if (!user) {
      return res.status(200).json({
        accountType: "unknown",
        message:
          "Nếu email tồn tại trong hệ thống, FlowChat đã gửi liên kết đặt lại mật khẩu.",
      });
    }

    if (!user.hashedPassword && user.googleId) {
      return res.status(200).json({
        accountType: "google",
        message:
          "Tài khoản này đăng nhập bằng Google. Vui lòng đổi hoặc khôi phục mật khẩu trong tài khoản Google của bạn.",
      });
    }

    if (!isEmailDeliveryConfigured()) {
      return res.status(503).json({
        message: "Máy chủ chưa được cấu hình gửi email đặt lại mật khẩu.",
      });
    }

    const reset = createOneTimeToken();
    user.passwordResetTokenHash = reset.hash;
    user.passwordResetExpiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
    await user.save();
    await sendPasswordResetEmail({
      to: user.email,
      displayName: user.displayName,
      token: reset.token,
    });

    return res.status(200).json({
      accountType: "local",
      message:
        "FlowChat đã gửi liên kết đặt lại mật khẩu. Vui lòng kiểm tra email.",
    });
  } catch (error) {
    console.error("Lỗi khi gửi email đặt lại mật khẩu", error);
    return res.status(502).json({
      message: "Không thể gửi email đặt lại mật khẩu. Vui lòng thử lại sau.",
    });
  }
};

export const resetPassword = async (
  req: Request,
  res: Response
): Promise<any> => {
  try {
    const token = String(req.body?.token || "").trim();
    const password = String(req.body?.password || "");
    if (!token) {
      return res.status(400).json({ message: "Thiếu mã đặt lại mật khẩu." });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Mật khẩu mới phải có ít nhất 6 ký tự." });
    }

    const user = await User.findOne({
      passwordResetTokenHash: tokenHash(token),
      passwordResetExpiresAt: { $gt: new Date() },
    }).select("+passwordResetTokenHash +passwordResetExpiresAt");
    if (!user) {
      return res.status(400).json({
        message:
          "Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.",
      });
    }
    if (!user.hashedPassword && user.googleId) {
      return res.status(400).json({
        code: "GOOGLE_ACCOUNT",
        message:
          "Tài khoản Google không sử dụng mật khẩu FlowChat. Vui lòng quản lý mật khẩu tại Google.",
      });
    }

    user.hashedPassword = await bcrypt.hash(password, 10);
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpiresAt = undefined;
    await user.save();
    await Session.deleteMany({ userId: user._id });

    return res.status(200).json({
      message: "Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.",
    });
  } catch (error) {
    console.error("Lỗi khi đặt lại mật khẩu", error);
    return res.status(500).json({ message: "Không thể đặt lại mật khẩu." });
  }
};

export const signOut = async (req: Request, res: Response): Promise<any> => {
  try {
    // lấy refresh token từ cookie
    const token = req.cookies?.refreshToken;

    if (token) {
      // xoá refresh token trong Session
      await Session.deleteOne({ refreshToken: token });

      // xoá cookie
      res.clearCookie("refreshToken");
    }

    return res.sendStatus(204);
  } catch (error) {
    console.error("Lỗi khi gọi signOut", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};

// tạo access token mới từ refresh token
export const refreshToken = async (req: Request, res: Response): Promise<any> => {
  try {
    // lấy refresh token từ cookie
    const token = req.cookies?.refreshToken;
    if (!token) {
      return res.status(401).json({ message: "Token không tồn tại." });
    }

    // so với refresh token trong db
    const session = await Session.findOne({ refreshToken: token });

    if (!session) {
      return res.status(403).json({ message: "Token không hợp lệ hoặc đã hết hạn" });
    }

    // kiểm tra hết hạn chưa
    if (session.expiresAt < new Date()) {
      return res.status(403).json({ message: "Token đã hết hạn." });
    }

    // tạo access token mới
    const accessToken = jwt.sign(
      {
        userId: session.userId,
      },
      config.ACCESS_TOKEN_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    // return
    return res.status(200).json({ accessToken });
  } catch (error) {
    console.error("Lỗi khi gọi refreshToken", error);
    return res.status(500).json({ message: "Lỗi hệ thống" });
  }
};
