import multer from "multer";
import { NextFunction, Request, Response } from "express";
import { v2 as cloudinary, UploadApiResponse, UploadApiOptions } from "cloudinary";
import type {
  AttachmentKind,
  AttachmentResourceType,
} from "../models/Message.js";

const MEBIBYTE = 1024 * 1024;

export const MESSAGE_ATTACHMENT_LIMITS: Record<AttachmentKind, number> = {
  image: 10 * MEBIBYTE,
  video: 50 * MEBIBYTE,
  file: 20 * MEBIBYTE,
};

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/heic",
  "image/heif",
]);

const VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/mpeg",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/x-m4v",
  "video/3gpp",
  "video/3gpp2",
]);

const FILE_MIME_TYPES = new Set([
  "application/pdf",
  "application/x-pdf",
  "text/plain",
  "text/csv",
  "application/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/x-7z-compressed",
]);

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "heic",
  "heif",
]);
const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mpeg",
  "mpg",
  "webm",
  "mov",
  "avi",
  "mkv",
  "m4v",
  "3gp",
  "3g2",
]);
const FILE_EXTENSIONS = new Set([
  "pdf",
  "txt",
  "csv",
  "rtf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "zip",
  "rar",
  "7z",
]);

class MessageUploadError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "MessageUploadError";
  }
}

export const getMessageAttachmentKind = (
  mimeType: string,
  fileName?: string
): AttachmentKind | null => {
  const normalizedMimeType = mimeType.toLowerCase().split(";")[0].trim();
  if (IMAGE_MIME_TYPES.has(normalizedMimeType)) return "image";
  if (VIDEO_MIME_TYPES.has(normalizedMimeType)) return "video";
  if (FILE_MIME_TYPES.has(normalizedMimeType)) return "file";

  // Some Android document providers only report application/octet-stream.
  // In that one case, fall back to a strict extension allowlist. Known but
  // unsupported MIME types (for example SVG/HTML) never get this fallback.
  if (
    fileName &&
    (!normalizedMimeType || normalizedMimeType === "application/octet-stream")
  ) {
    const extension = fileName.split(".").pop()?.toLowerCase() || "";
    if (IMAGE_EXTENSIONS.has(extension)) return "image";
    if (VIDEO_EXTENSIONS.has(extension)) return "video";
    if (FILE_EXTENSIONS.has(extension)) return "file";
  }

  return null;
};

export const sanitizeAttachmentFileName = (fileName: string): string => {
  const baseName = fileName.split(/[\\/]/).pop() || "tep-dinh-kem";
  const sanitized = baseName.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (sanitized || "tep-dinh-kem").slice(0, 180);
};

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1024 * 1024 * 1, // 1MB
  },
});

const messageFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: MESSAGE_ATTACHMENT_LIMITS.video,
  },
  fileFilter: (_req, file, callback) => {
    if (!getMessageAttachmentKind(file.mimetype, file.originalname)) {
      callback(
        new MessageUploadError(
          "Định dạng tệp không được hỗ trợ. Hãy chọn ảnh, video, PDF, tài liệu Office, tệp văn bản hoặc tệp nén.",
          415
        )
      );
      return;
    }

    callback(null, true);
  },
}).single("file");

/**
 * Parses both legacy JSON requests and multipart message requests. Multer errors
 * are normalized to JSON so clients never receive Express' default HTML page.
 */
export const uploadMessageFile = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  messageFileUpload(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          message: "Video không được vượt quá 50 MB",
          limits: MESSAGE_ATTACHMENT_LIMITS,
        });
        return;
      }

      res.status(400).json({
        message:
          error.code === "LIMIT_UNEXPECTED_FILE"
            ? "Chỉ chấp nhận một tệp trong trường 'file'"
            : "Dữ liệu tệp tải lên không hợp lệ",
      });
      return;
    }

    if (error instanceof MessageUploadError) {
      res.status(error.status).json({ message: error.message });
      return;
    }

    console.error("Lỗi khi đọc tệp tin nhắn", error);
    res.status(400).json({ message: "Không thể đọc tệp tải lên" });
  });
};

export const uploadImageFromBuffer = (
  buffer: Buffer,
  options?: UploadApiOptions
): Promise<UploadApiResponse> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "flowchat_chat/avatars",
        resource_type: "image",
        transformation: [{ width: 200, height: 200, crop: "fill" }],
        ...options,
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error("Failed to upload image to Cloudinary"));
        } else {
          resolve(result);
        }
      }
    );

    uploadStream.end(buffer);
  });
};

export const uploadMessageFileFromBuffer = (
  buffer: Buffer,
  resourceType: AttachmentResourceType,
  originalFileName: string
): Promise<UploadApiResponse> => {
  const fileName = sanitizeAttachmentFileName(originalFileName);

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "flowchat_chat/messages",
        resource_type: resourceType,
        use_filename: true,
        unique_filename: true,
        overwrite: false,
        filename_override: fileName,
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error("Failed to upload message file to Cloudinary"));
        } else {
          resolve(result);
        }
      }
    );

    uploadStream.end(buffer);
  });
};

export const destroyMessageFile = async (
  publicId: string,
  resourceType: AttachmentResourceType
): Promise<void> => {
  await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    invalidate: true,
  });
};
