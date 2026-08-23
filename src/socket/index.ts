import { Server } from "socket.io";
import http from "http";
import express from "express";
import { socketAuthMiddleware } from "../middlewares/socketMiddleware.js";
import { getUserConversationsForSocketIO } from "../controllers/conversationController.js";
import { config } from "../config/index.js";
import { CallSignaling } from "./callSignaling.js";
import { Types } from "mongoose";
import Conversation from "../models/Conversation.js";
import User from "../models/User.js";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: config.CLIENT_URL,
    credentials: true,
  },
});

io.use(socketAuthMiddleware);

const onlineUsers = new Map<string, Set<string>>(); // {userId: socketIds}
const callSignaling = new CallSignaling(io, onlineUsers);

export function isUserOnline(userId: string): boolean {
  return (onlineUsers.get(userId)?.size ?? 0) > 0;
}

export async function broadcastOnlineUsers(): Promise<void> {
  const connectedUserIds = Array.from(onlineUsers.keys());
  if (connectedUserIds.length === 0) {
    io.emit("online-users", []);
    return;
  }
  const visibleUserIds = await User.find({
    _id: { $in: connectedUserIds },
    showOnlineStatus: { $ne: false },
  }).distinct("_id");
  io.emit("online-users", visibleUserIds.map((id) => id.toString()));
}

io.on("connection", async (socket) => {
  const user = socket.user;
  if (!user) {
    return;
  }

  const userIdStr = user._id.toString();

  const userSockets = onlineUsers.get(userIdStr) ?? new Set<string>();
  userSockets.add(socket.id);
  onlineUsers.set(userIdStr, userSockets);

  await broadcastOnlineUsers();

  // User rooms intentionally contain every web/mobile socket for that account.
  socket.join(userIdStr);
  callSignaling.registerSocket(socket);

  socket.on("disconnect", () => {
    const connectedSockets = onlineUsers.get(userIdStr);
    connectedSockets?.delete(socket.id);
    if (connectedSockets?.size === 0) {
      onlineUsers.delete(userIdStr);
      void User.findByIdAndUpdate(userIdStr, { $set: { lastSeenAt: new Date() } });
    }

    callSignaling.handleDisconnect(socket);
    void broadcastOnlineUsers();
  });

  const conversationIds = await getUserConversationsForSocketIO(user._id);
  if (!socket.connected) return;

  conversationIds.forEach((id) => {
    socket.join(id);
  });

  socket.on("join-conversation", async (rawConversationId: unknown, ack?: unknown) => {
    const acknowledge = typeof ack === "function" ? ack : undefined;
    if (
      typeof rawConversationId !== "string" ||
      !OBJECT_ID_PATTERN.test(rawConversationId)
    ) {
      acknowledge?.({ ok: false, error: "INVALID_CONVERSATION" });
      return;
    }

    const conversationId = new Types.ObjectId(rawConversationId).toString();
    try {
      const isMember = await Conversation.exists({
        _id: conversationId,
        "participants.userId": user._id,
      });
      if (!isMember || !socket.connected) {
        acknowledge?.({ ok: false, error: "CONVERSATION_NOT_FOUND" });
        return;
      }

      await socket.join(conversationId);
      acknowledge?.({ ok: true });
    } catch (error) {
      console.error("Lỗi khi tham gia phòng trò chuyện", error);
      acknowledge?.({ ok: false, error: "INTERNAL_ERROR" });
    }
  });
});

export { io, app, server };
