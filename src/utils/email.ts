import nodemailer from "nodemailer";
import { config } from "../config/index.js";

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

export function isEmailDeliveryConfigured(): boolean {
  return Boolean(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS);
}

function mailTransport() {
  if (!isEmailDeliveryConfigured()) {
    throw new Error(
      "SMTP chưa được cấu hình. Cần SMTP_HOST, SMTP_USER và SMTP_PASS."
    );
  }

  transporter ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: {
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
    },
  });
  return transporter;
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}

async function sendActionEmail(options: {
  to: string;
  displayName: string;
  subject: string;
  heading: string;
  description: string;
  actionLabel: string;
  actionUrl: string;
}): Promise<void> {
  const safeName = escapeHtml(options.displayName);
  const safeUrl = escapeHtml(options.actionUrl);
  await mailTransport().sendMail({
    from: config.SMTP_FROM || `FlowChat <${config.SMTP_USER}>`,
    to: options.to,
    subject: options.subject,
    text: `${options.heading}\n\n${options.description}\n\n${options.actionUrl}\n\nLiên kết có thời hạn và chỉ sử dụng được một lần.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#17213a">
        <h2>${escapeHtml(options.heading)}</h2>
        <p>Xin chào ${safeName},</p>
        <p>${escapeHtml(options.description)}</p>
        <p style="margin:28px 0">
          <a href="${safeUrl}" style="background:#8b2be2;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700">
            ${escapeHtml(options.actionLabel)}
          </a>
        </p>
        <p style="font-size:13px;color:#68708a">Liên kết có thời hạn và chỉ sử dụng được một lần. Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email.</p>
      </div>
    `,
  });
}

export function sendVerificationEmail(options: {
  to: string;
  displayName: string;
  token: string;
}): Promise<void> {
  const url = new URL("/verify-email", config.APP_PUBLIC_URL);
  url.searchParams.set("token", options.token);
  return sendActionEmail({
    ...options,
    subject: "Xác minh email FlowChat",
    heading: "Xác minh địa chỉ email",
    description:
      "Hãy nhấn nút bên dưới để xác nhận email này thuộc về bạn và kích hoạt tài khoản FlowChat.",
    actionLabel: "Xác minh email",
    actionUrl: url.toString(),
  });
}

export function sendPasswordResetEmail(options: {
  to: string;
  displayName: string;
  token: string;
}): Promise<void> {
  const url = new URL("/reset-password", config.APP_PUBLIC_URL);
  url.searchParams.set("token", options.token);
  return sendActionEmail({
    ...options,
    subject: "Đặt lại mật khẩu FlowChat",
    heading: "Đặt lại mật khẩu",
    description:
      "FlowChat đã nhận được yêu cầu đặt lại mật khẩu. Liên kết này hết hạn sau 30 phút.",
    actionLabel: "Đặt lại mật khẩu",
    actionUrl: url.toString(),
  });
}
